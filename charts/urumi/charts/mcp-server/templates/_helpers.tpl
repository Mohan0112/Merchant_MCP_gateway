{{/* The alias (woo-mcp, fx-mcp) is the chart name inside an aliased sub-chart. */}}
{{- define "mcp-server.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "mcp-server.labels" -}}
app.kubernetes.io/name: {{ include "mcp-server.name" . }}
app.kubernetes.io/component: mcp-server
app.kubernetes.io/part-of: urumi
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "mcp-server-%s" .Chart.Version }}
{{- end -}}

{{- define "mcp-server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mcp-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Host names the server accepts on /mcp: every in-cluster form of its Service name. */}}
{{- define "mcp-server.allowedHosts" -}}
{{- $name := include "mcp-server.name" . -}}
{{- $ns := .Release.Namespace -}}
{{- printf "%s,%s.%s,%s.%s.svc,%s.%s.svc.cluster.local" $name $name $ns $name $ns $name $ns -}}
{{- end -}}
