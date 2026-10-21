{{/*
Standard labels for every resource in the release.
*/}}
{{- define "ahjin.labels" -}}
app.kubernetes.io/part-of: ahjin
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
Public host for a component, e.g. include "ahjin.host" (list . "store") -> store.127.0.0.1.nip.io
*/}}
{{- define "ahjin.host" -}}
{{- $root := index . 0 -}}
{{- printf "%s.%s" (index . 1) $root.Values.global.domain -}}
{{- end -}}
