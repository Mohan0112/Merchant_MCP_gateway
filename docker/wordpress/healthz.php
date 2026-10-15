<?php
// Readiness check: PHP runs and the database answers. Deliberately outside WordPress so it stays
// cheap and works before WordPress is installed. Liveness uses a plain TCP check instead, so a
// database outage never restarts the web pod.
header('Content-Type: text/plain');
header('Cache-Control: no-store');

$host = getenv('WORDPRESS_DB_HOST') ?: 'mariadb';
$port = 3306;
if (strpos($host, ':') !== false) {
    [$host, $port] = explode(':', $host, 2);
    $port = (int) $port;
}

mysqli_report(MYSQLI_REPORT_OFF);
$db = @new mysqli($host, getenv('WORDPRESS_DB_USER'), getenv('WORDPRESS_DB_PASSWORD'), getenv('WORDPRESS_DB_NAME'), $port);

if ($db->connect_errno) {
    http_response_code(503);
    echo "database: unreachable\n";
    exit;
}

$db->close();
echo "ok\n";
