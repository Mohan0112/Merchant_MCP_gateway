<?php
/**
 * Plugin Name: Ahjin internal HTTPS
 * Description: Treats requests addressed to the in-cluster Service host name as HTTPS, so
 * WooCommerce accepts HTTP Basic Auth from woo-mcp (ADR-0002). Public traffic can't carry this
 * Host header: the ingress only routes the public store host to WordPress, and a NetworkPolicy
 * only lets the ingress and woo-mcp reach the pod.
 */

$ahjin_internal_host = getenv('AHJIN_INTERNAL_HOST');

if ($ahjin_internal_host && isset($_SERVER['HTTP_HOST'])) {
    $request_host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST']));
    if ($request_host === strtolower($ahjin_internal_host)) {
        $_SERVER['HTTPS'] = 'on';
    }
}
