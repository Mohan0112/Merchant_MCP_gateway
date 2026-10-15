{{/* Labels for a store component. Usage: include "store.labels" (list . "wordpress") */}}
{{- define "store.labels" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/component: store
app.kubernetes.io/part-of: urumi
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/managed-by: {{ $root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" $root.Chart.Name $root.Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "store.selectorLabels" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
{{- end -}}

{{/* Public storefront host, e.g. store.127.0.0.1.nip.io */}}
{{- define "store.host" -}}
{{- printf "store.%s" .Values.global.domain -}}
{{- end -}}

{{/* Public storefront URL used for WP_HOME / WP_SITEURL */}}
{{- define "store.url" -}}
{{- printf "%s://%s" .Values.wordpress.scheme (include "store.host" .) -}}
{{- end -}}

{{/* Restricted container security context shared by store containers. */}}
{{- define "store.containerSecurityContext" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: [ALL]
seccompProfile:
  type: RuntimeDefault
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
- name: URUMI_INTERNAL_HOST
  value: {{ .Values.wordpress.internalHost | quote }}
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', getenv('WP_HOME_URL'));
    define('WP_SITEURL', getenv('WP_HOME_URL'));
    define('WP_ENVIRONMENT_TYPE', getenv('WP_ENVIRONMENT_TYPE') ?: 'production');
    define('DISABLE_WP_CRON', true);
    define('DISALLOW_FILE_MODS', true);
    if (getenv('TRUST_FORWARDED_PROTO') === 'true' && ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') {
        $_SERVER['HTTPS'] = 'on';
    }
{{- end -}}
