{{/* Labels for a platform component. Usage: include "platform.labels" (list . "gateway") */}}
{{- define "platform.labels" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/component: platform
app.kubernetes.io/part-of: ahjin
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/managed-by: {{ $root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" $root.Chart.Name $root.Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "platform.selectorLabels" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
{{- end -}}

{{/* Public host of the dashboard and gateway, e.g. app.127.0.0.1.nip.io */}}
{{- define "platform.host" -}}
{{- printf "app.%s" .Values.global.domain -}}
{{- end -}}

{{- define "platform.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* Database connection settings (node-postgres reads the PG* variables directly). */}}
{{- define "platform.databaseEnv" -}}
- name: PGHOST
  value: postgres
- name: PGPORT
  value: '5432'
- name: PGDATABASE
  value: {{ .Values.postgres.database | quote }}
- name: PGUSER
  value: {{ .Values.postgres.user | quote }}
- name: PGPASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Values.secrets.db }}, key: password }
{{- end -}}

{{/* Environment variable that carries one seeded upstream's credential, e.g. SEED_CREDENTIAL_WOO. */}}
{{- define "platform.seedCredentialEnv" -}}
{{- printf "SEED_CREDENTIAL_%s" (. | upper | replace "-" "_") -}}
{{- end -}}

{{/* SEED_UPSTREAMS as JSON: each seed points at its credential's environment variable, never the value. */}}
{{- define "platform.seedUpstreams" -}}
{{- $seeds := list -}}
{{- range .Values.gateway.seedUpstreams -}}
{{- $seed := omit . "credentialSecret" -}}
{{- if .credentialSecret -}}
{{- $_ := set $seed "credentialEnv" (include "platform.seedCredentialEnv" .slug) -}}
{{- end -}}
{{- $seeds = append $seeds $seed -}}
{{- end -}}
{{- toJson $seeds -}}
{{- end -}}
