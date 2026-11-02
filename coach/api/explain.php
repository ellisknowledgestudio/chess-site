<?php
/**
 * Ellis Knowledge Studio – AI Chess Coach relay.
 *
 * The browser sends: the position, the move played and Stockfish's analysis.
 * This script checks it, enforces the free daily limit, asks Claude to explain
 * the move in plain English, checks the answer only mentions engine-approved
 * moves, and sends the explanation back. Your API key never leaves the server.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

// ---------------------------------------------------------------- config ---
$config = null;
// Looks in each folder above this one, so it works however the subdomain is laid out.
for ($dir = dirname(__DIR__), $i = 0; $i < 6; $i++, $dir = dirname($dir)) {
    if (is_file("$dir/coach-config.php")) { $config = require "$dir/coach-config.php"; break; }
}
if (!is_array($config)) {
    fail(500, 'Coach is not configured yet (coach-config.php not found above public_html).');
}

// ---------------------------------------------------------------- CORS -----
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '') {
    if (!in_array($origin, $config['allowed_origins'] ?? [], true)) {
        fail(403, 'This site is not allowed to use the coach.');
    }
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { fail(405, 'POST only.'); }

// ---------------------------------------------------------------- input ----
$raw = file_get_contents('php://input', false, null, 0, 8192);
$in = json_decode((string)$raw, true);
if (!is_array($in)) { fail(400, 'Bad request.'); }

$SAN = '/^(?:O-O(?:-O)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?$/';
$FEN = '/^([pnbrqkPNBRQK1-8]{1,8}\/){7}[pnbrqkPNBRQK1-8]{1,8} [wb] (-|[KQkq]{1,4}) (-|[a-h][36]) \d{1,3} \d{1,4}$/';

$fen   = trim((string)($in['fen'] ?? ''));
$move  = trim((string)($in['move'] ?? ''));
$level = (string)($in['level'] ?? 'club');
$mover = ($in['mover'] ?? 'student') === 'coach' ? 'coach' : 'student';
$class = (string)($in['classification'] ?? '');
$best  = trim((string)($in['bestMove'] ?? ''));
$bestLine  = is_array($in['bestLine'] ?? null) ? array_slice($in['bestLine'], 0, 10) : [];
$replyLine = is_array($in['replyLine'] ?? null) ? array_slice($in['replyLine'], 0, 10) : [];

if (!preg_match($FEN, $fen))  { fail(400, 'Invalid position.'); }
if (!preg_match($SAN, $move)) { fail(400, 'Invalid move.'); }
if ($best !== '' && !preg_match($SAN, $best)) { fail(400, 'Invalid engine move.'); }
foreach (array_merge($bestLine, $replyLine) as $m) {
    if (!is_string($m) || !preg_match($SAN, $m)) { fail(400, 'Invalid engine line.'); }
}
if (!in_array($level, ['beginner', 'club', 'advanced'], true)) { $level = 'club'; }
if (!in_array($class, ['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'], true)) { $class = 'good'; }
$evalBefore = readEval($in['evalBefore'] ?? null);
$evalAfter  = readEval($in['evalAfter'] ?? null);
if ($evalBefore === null || $evalAfter === null) { fail(400, 'Missing engine evaluation.'); }

// ---------------------------------------------------------------- storage --
$dataDir = rtrim((string)$config['data_dir'], '/');
if (!is_dir($dataDir . '/cache') && !@mkdir($dataDir . '/cache', 0750, true)) {
    fail(500, 'Coach data folder is not writable.');
}

$req = compact('fen', 'move', 'mover', 'level', 'class', 'best', 'bestLine', 'replyLine', 'evalBefore', 'evalAfter');
$cacheKey = sha1(json_encode($req) . '|' . (!empty($config['mock']) ? 'mock' : $config['model']));
$cacheFile = "$dataDir/cache/$cacheKey.json";
$visitor = hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? '') . '|' . date('Y-m-d') . '|' . __FILE__);

// Same position + move + level asked before? Serve it free.
if (is_file($cacheFile)) {
    $hit = json_decode((string)file_get_contents($cacheFile), true);
    if (is_array($hit)) {
        $hit['cached'] = true;
        $hit['remaining'] = remaining($dataDir, $visitor, $config);
        echo json_encode($hit);
        exit;
    }
}

// Enforce limits (reserve a slot before calling the AI).
$usage = withUsage($dataDir, function (array &$u) use ($visitor, $config) {
    $mine = $u['visitors'][$visitor] ?? 0;
    if (($u['total'] ?? 0) >= $config['daily_limit_total']) { return 'site'; }
    if ($mine >= $config['daily_limit_per_visitor']) { return 'visitor'; }
    $u['visitors'][$visitor] = $mine + 1;
    $u['total'] = ($u['total'] ?? 0) + 1;
    return $config['daily_limit_per_visitor'] - $mine - 1;
});
if ($usage === 'visitor') { fail(429, "You've used today's free explanations. Come back tomorrow!", ['remaining' => 0]); }
if ($usage === 'site')    { fail(429, 'The coach is resting for today – please try again tomorrow.', ['remaining' => 0]); }

// ---------------------------------------------------------------- ask ------
$allowed = array_map('normMove', array_filter(array_merge([$move, $best], $bestLine, $replyLine)));
$prompt = buildPrompt($req);

if (!empty($config['mock'])) {
    $text = mockExplanation($req);
    $tokens = [0, 0];
} else {
    if (empty($config['api_key'])) { refund($dataDir, $visitor); fail(500, 'API key missing in coach-config.php.'); }
    [$text, $tokens] = askClaude($config, [['role' => 'user', 'content' => $prompt]]);
    if ($text === null) { refund($dataDir, $visitor); fail(502, 'The coach could not answer just now. Please try again.'); }

    // Guard rail: every concrete move mentioned must come from the engine lines.
    $bad = unknownMoves($text, $allowed);
    if ($bad) {
        [$retry, $t2] = askClaude($config, [
            ['role' => 'user', 'content' => $prompt],
            ['role' => 'assistant', 'content' => $text],
            ['role' => 'user', 'content' => 'You mentioned ' . implode(', ', $bad) . ', which are not in the engine lines. Rewrite the explanation using only moves from the engine lines above; describe any other idea in words instead of moves.'],
        ]);
        $tokens = [$tokens[0] + $t2[0], $tokens[1] + $t2[1]];
        if ($retry !== null) { $text = $retry; $bad = unknownMoves($text, $allowed); }
    }
}

$out = [
    'ok' => true,
    'text' => trim($text),
    'classification' => $class,
    'unverified' => array_values($bad ?? []),
    'remaining' => $usage,
    'cached' => false,
];
withUsage($dataDir, function (array &$u) use ($tokens) {
    $u['input_tokens'] = ($u['input_tokens'] ?? 0) + $tokens[0];
    $u['output_tokens'] = ($u['output_tokens'] ?? 0) + $tokens[1];
    return null;
});
if (empty($out['unverified'])) { @file_put_contents($cacheFile, json_encode($out), LOCK_EX); }
echo json_encode($out);
exit;

// ============================================================ functions ====

function fail(int $code, string $msg, array $extra = []): void {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $msg] + $extra);
    exit;
}

/** Eval from the mover's point of view: {cp:int} or {mate:int}. */
function readEval($e): ?array {
    if (!is_array($e)) { return null; }
    if (isset($e['mate']) && is_numeric($e['mate'])) { return ['mate' => max(-99, min(99, (int)$e['mate']))]; }
    if (isset($e['cp']) && is_numeric($e['cp']))     { return ['cp' => max(-5000, min(5000, (int)$e['cp']))]; }
    return null;
}

function withUsage(string $dir, callable $fn) {
    $file = "$dir/usage-" . date('Y-m-d') . '.json';
    $fh = fopen($file, 'c+');
    if (!$fh) { fail(500, 'Coach data folder is not writable.'); }
    flock($fh, LOCK_EX);
    $u = json_decode((string)stream_get_contents($fh), true) ?: ['total' => 0, 'visitors' => []];
    $result = $fn($u);
    ftruncate($fh, 0); rewind($fh);
    fwrite($fh, json_encode($u));
    flock($fh, LOCK_UN); fclose($fh);
    if (mt_rand(1, 50) === 1) { cleanup($dir); }
    return $result;
}

function remaining(string $dir, string $visitor, array $config): int {
    $file = "$dir/usage-" . date('Y-m-d') . '.json';
    $u = is_file($file) ? (json_decode((string)file_get_contents($file), true) ?: []) : [];
    return max(0, $config['daily_limit_per_visitor'] - ($u['visitors'][$visitor] ?? 0));
}

function refund(string $dir, string $visitor): void {
    withUsage($dir, function (array &$u) use ($visitor) {
        $u['visitors'][$visitor] = max(0, ($u['visitors'][$visitor] ?? 1) - 1);
        $u['total'] = max(0, ($u['total'] ?? 1) - 1);
        return null;
    });
}

function cleanup(string $dir): void {
    // Keep 60 days of usage logs; drop cached answers older than 90 days.
    foreach (glob("$dir/usage-*.json") ?: [] as $f) { if (filemtime($f) < time() - 60 * 86400) { @unlink($f); } }
    foreach (glob("$dir/cache/*.json") ?: [] as $f) { if (filemtime($f) < time() - 90 * 86400) { @unlink($f); } }
}

function normMove(string $m): string { return rtrim(str_replace('0-0', 'O-O', $m), '+#!?'); }

/** Concrete moves in the text that the engine never gave us. */
function unknownMoves(string $text, array $allowed): array {
    preg_match_all('/(?<![A-Za-z0-9])(O-O(?:-O)?|0-0(?:-0)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][18]=[QRBN])[+#]?/', $text, $m);
    $bad = [];
    foreach ($m[1] as $tok) {
        $n = normMove($tok);
        if (!in_array($n, $allowed, true)) { $bad[$n] = true; }
    }
    return array_keys($bad);
}

function describeEval(array $e, string $mover = 'the student', string $other = 'the opponent'): string {
    if (isset($e['mate'])) {
        return $e['mate'] > 0 ? "$mover can force mate in {$e['mate']}"
                              : "$other can force mate in " . abs($e['mate']);
    }
    $p = round(abs($e['cp']) / 100, 1);
    if ($p < 0.3) { return 'roughly equal'; }
    return ($e['cp'] > 0 ? $mover : $other) . " is better by about " . number_format($p, 1) . " pawns";
}

function boardFromFen(string $fen): array {
    $names = ['k' => 'King', 'q' => 'Queen', 'r' => 'Rook', 'b' => 'Bishop', 'n' => 'Knight', 'p' => 'Pawn'];
    $rows = explode('/', explode(' ', $fen)[0]);
    $ascii = [];
    $pieces = ['White' => [], 'Black' => []];
    foreach ($rows as $i => $row) {
        $rank = 8 - $i; $file = 0; $line = "$rank |";
        foreach (str_split($row) as $c) {
            if (ctype_digit($c)) { $line .= str_repeat(' .', (int)$c); $file += (int)$c; continue; }
            $sq = chr(97 + $file) . $rank;
            $line .= ' ' . $c;
            $pieces[ctype_upper($c) ? 'White' : 'Black'][] = $names[strtolower($c)] . " $sq";
            $file++;
        }
        $ascii[] = $line;
    }
    $ascii[] = '    a b c d e f g h';
    return [implode("\n", $ascii), $pieces];
}

function buildPrompt(array $r): string {
    [$ascii, $pieces] = boardFromFen($r['fen']);
    $parts = explode(' ', $r['fen']);
    $side = $parts[1] === 'w' ? 'White' : 'Black';
    $num = (int)$parts[5];
    $moveLabel = $num . ($side === 'White' ? '. ' : '... ') . $r['move'];
    $bestLine = $r['bestLine'] ? implode(' ', $r['bestLine']) : '(not given)';
    $replyLine = $r['replyLine'] ? implode(' ', $r['replyLine']) : '(not given)';
    $levelText = [
        'beginner' => 'a beginner (under about 1200). Use simple words, name the pieces, avoid jargon, focus on one clear idea.',
        'club'     => 'a club player (about 1200-1800). Use normal chess vocabulary and focus on the key tactical or strategic point.',
        'advanced' => 'a strong player (1800+). Be concise and precise; mention the deeper positional or tactical reason.',
    ][$r['level']];

    $white = implode(', ', $pieces['White']);
    $black = implode(', ', $pieces['Black']);
    [$mv, $ot] = $r['mover'] === 'coach' ? ['the coach', 'the student'] : ['the student', 'the opponent'];
    $before = describeEval($r['evalBefore'], $mv, $ot);
    $after = describeEval($r['evalAfter'], $mv, $ot);

    $who = $r['mover'] === 'coach'
        ? "This move was played BY THE COACH (you, the engine opponent) against the student, who has the other colour. Explain what the move is aiming for and what the student should watch out for or how they could respond. Talk about \"my move\" and \"your position\". The student's level: {$levelText}"
        : "The student is playing {$side}. Their level: {$levelText}";

    return <<<TXT
{$who}

Position BEFORE the move ({$side} to move). Uppercase = White, lowercase = Black.
{$ascii}
White: {$white}
Black: {$black}

Move played: {$moveLabel}
Engine verdict on this move: {$r['class']}

Stockfish analysis (trust it completely):
- With best play before the move, {$before}.
- Engine's best move was {$r['best']}; best line: {$bestLine}
- After {$r['move']}, {$after}.
- Best reply and continuation after {$r['move']}: {$replyLine}

Explain this move to the student.
TXT;
}

function systemPrompt(): string {
    return <<<TXT
You are the chess coach on Ellis Knowledge Studio's chess site, explaining one move from a student's game: either a move the student played, or a move you played as their opponent. You receive the position, the move, and Stockfish's analysis. Stockfish is always right about which moves are good or bad; your job is to explain WHY, in human terms a coach would use.

Rules:
- Only name concrete moves that appear in the move played, the engine's best move, or the engine lines given. Never invent or calculate other variations. For anything beyond those lines, talk about ideas (loose pieces, king safety, piece activity, pawn structure, tempo, weak squares) in words, not moves.
- Write moves in standard algebraic notation (Nf3, exd5, O-O).
- Never contradict the engine's evaluation or verdict.
- If the move was best, excellent or good, say so briefly and explain the idea behind it; do not invent flaws.
- If it was an inaccuracy, mistake or blunder, explain what it allows (using the opponent's reply line) and why the engine's best move is better.
- Match the student's level as described.
- 2 to 4 short sentences, then one final line starting "Takeaway:" with a general lesson they can reuse in other games.
- Plain text only: no markdown, no headings, no bullet points. Address the student as "you".
TXT;
}

/** @return array{0: ?string, 1: array{0:int,1:int}} */
function askClaude(array $config, array $messages): array {
    $ch = curl_init($config['api_url'] ?? 'https://api.anthropic.com/v1/messages');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_HTTPHEADER => [
            'content-type: application/json',
            'x-api-key: ' . $config['api_key'],
            'anthropic-version: 2023-06-01',
        ],
        CURLOPT_POSTFIELDS => json_encode([
            'model' => $config['model'],
            'max_tokens' => (int)($config['max_tokens'] ?? 350),
            'system' => systemPrompt(),
            'messages' => $messages,
        ]),
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $data = is_string($body) ? json_decode($body, true) : null;
    if ($status !== 200 || !is_array($data)) {
        error_log('Chess coach API error ' . $status . ': ' . substr((string)$body, 0, 500));
        return [null, [0, 0]];
    }
    $text = '';
    foreach ($data['content'] ?? [] as $block) {
        if (($block['type'] ?? '') === 'text') { $text .= $block['text']; }
    }
    $tokens = [(int)($data['usage']['input_tokens'] ?? 0), (int)($data['usage']['output_tokens'] ?? 0)];
    return [$text !== '' ? $text : null, $tokens];
}

/** Test mode: a template answer built from the engine data (no AI call, no cost). */
function mockExplanation(array $r): string {
    $good = in_array($r['class'], ['best', 'excellent', 'good'], true);
    if ($good) {
        $s = "{$r['move']} is a {$r['class']} move – the engine agrees with your choice here.";
        if ($r['bestLine']) { $s .= ' The main line runs ' . implode(' ', array_slice($r['bestLine'], 0, 5)) . '.'; }
        return $s . "\n[Mock mode – switch 'mock' off in coach-config.php for real coaching.]\nTakeaway: Keep checking your opponent's most forcing replies before you move.";
    }
    $s = "{$r['move']} is a {$r['class']}. After it, " . describeEval($r['evalAfter'], $r['mover'] === 'coach' ? 'the coach' : 'the student', $r['mover'] === 'coach' ? 'the student' : 'the opponent') . '.';
    if ($r['replyLine']) { $s .= ' The opponent can answer ' . implode(' ', array_slice($r['replyLine'], 0, 4)) . '.'; }
    if ($r['best']) { $s .= " The engine preferred {$r['best']}."; }
    return $s . "\n[Mock mode – switch 'mock' off in coach-config.php for real coaching.]\nTakeaway: Before you move, look at every check, capture and threat your opponent will have.";
}
