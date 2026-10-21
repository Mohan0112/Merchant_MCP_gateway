{{/* Labels for a store component. Usage: include "store.labels" (list . "wordpress") */}}
{{- define "store.labels" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/component: store
app.kubernetes.io/part-of: ahjin
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/managed-by: {{ $root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" $root.Chart.Name $root.Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "store.selectorLabels" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
{{- end -}}

{{/* Public storefront host: store.<domain> (e.g. store.127.0.0.1.nip.io), or ingress.host for a provisioned store */}}
{{- define "store.host" -}}
{{- default (printf "store.%s" .Values.global.domain) .Values.ingress.host -}}
{{- end -}}

{{/* Public storefront URL used for WP_HOME / WP_SITEURL (global.scheme: http locally, https in prod) */}}
{{- define "store.url" -}}
{{- printf "%s://%s" .Values.global.scheme (include "store.host" .) -}}
{{- end -}}

{{/* Restricted container security context shared by store containers. */}}
{{- define "store.containerSecurityContext" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: [ALL]
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* Extra environment for the bootstrap Job: admin login, REST key and store settings. */}}
{{- define "store.bootstrapEnv" -}}
{{- range $env, $key := dict "WP_ADMIN_USER" "admin-user" "WP_ADMIN_EMAIL" "admin-email" "WP_ADMIN_PASSWORD" "admin-password" }}
- name: {{ $env }}
  valueFrom:
    secretKeyRef: { name: {{ $.Values.secrets.wordpress }}, key: {{ $key }} }
{{- end }}
- name: WOO_CONSUMER_KEY
  valueFrom:
    secretKeyRef: { name: {{ .Values.secrets.wooApi }}, key: consumer-key }
- name: WOO_CONSUMER_SECRET
  valueFrom:
    secretKeyRef: { name: {{ .Values.secrets.wooApi }}, key: consumer-secret }
- name: STORE_NAME
  value: {{ .Values.settings.name | quote }}
- name: STORE_CURRENCY
  value: {{ .Values.settings.currency | quote }}
- name: STORE_TIMEZONE
  value: {{ .Values.settings.timezone | quote }}
- name: STORE_COUNTRY
  value: {{ .Values.settings.country | quote }}
- name: STORE_CITY
  value: {{ .Values.settings.city | quote }}
- name: STORE_ADDRESS
  value: {{ .Values.settings.address | quote }}
- name: STORE_POSTCODE
  value: {{ .Values.settings.postcode | quote }}
{{- end -}}

{{/* WordPress database and salt environment, shared by the web pod and WP-CLI jobs. */}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: mariadb
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database | quote }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.user | quote }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Values.secrets.db }}, key: password }
{{- range $env, $key := dict "WORDPRESS_AUTH_KEY" "auth-key" "WORDPRESS_SECURE_AUTH_KEY" "secure-auth-key" "WORDPRESS_LOGGED_IN_KEY" "logged-in-key" "WORDPRESS_NONCE_KEY" "nonce-key" "WORDPRESS_AUTH_SALT" "auth-salt" "WORDPRESS_SECURE_AUTH_SALT" "secure-auth-salt" "WORDPRESS_LOGGED_IN_SALT" "logged-in-salt" "WORDPRESS_NONCE_SALT" "nonce-salt" }}
- name: {{ $env }}
  valueFrom:
    secretKeyRef: { name: {{ $.Values.secrets.wordpress }}, key: {{ $key }} }
{{- end }}
- name: WP_HOME_URL
  value: {{ include "store.url" . | quote }}
- name: WP_ENVIRONMENT_TYPE
  value: {{ .Values.wordpress.environmentType | quote }}
- name: TRUST_FORWARDED_PROTO
  value: {{ .Values.wordpress.trustForwardedProto | quote }}
- name: AHJIN_INTERNAL_HOST
  value: {{ .Values.wordpress.internalHost | quote }}
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', getenv('WP_HOME_URL'));
    define('WP_SITEURL', getenv('WP_HOME_URL'));
    define('WP_ENVIRONMENT_TYPE', getenv('WP_ENVIRONMENT_TYPE') ?: 'production');
    define('DISABLE_WP_CRON', true);
    define('DISALLOW_FILE_MODS', true);
    define('AUTOMATIC_UPDATER_DISABLED', true);
    // Egress is closed by NetworkPolicy; refuse outbound HTTP at once instead of timing out.
    define('WP_HTTP_BLOCK_EXTERNAL', true);
    if (getenv('TRUST_FORWARDED_PROTO') === 'true' && ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') {
        $_SERVER['HTTPS'] = 'on';
    }
{{- end -}}
