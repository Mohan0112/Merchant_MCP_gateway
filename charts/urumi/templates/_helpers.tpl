{{/*
Standard labels for every resource in the release.
*/}}
{{- define "urumi.labels" -}}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
Public host for a component, e.g. include "urumi.host" (list . "store") -> store.127.0.0.1.nip.io
*/}}
{{- define "urumi.host" -}}
{{- $root := index . 0 -}}
{{- printf "%s.%s" (index . 1) $root.Values.global.domain -}}
{{- end -}}
