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

{{/*
Egress rule to the Kubernetes API server, for the components that call it (the store operator, and
the gateway when stores are on). NetworkPolicies see the API server's real address (the Service IP
is translated first), so the rule names those addresses: global.networkPolicy.kubeApi.cidrs when
set, otherwise the "kubernetes" EndpointSlice, looked up at install and upgrade time. An offline
render (helm template) finds nothing and renders no rule.
*/}}
{{- define "ahjin.kubeApiEgress" -}}
{{- $api := .Values.global.networkPolicy.kubeApi | default dict -}}
{{- $cidrs := $api.cidrs | default list -}}
{{- $ports := $api.ports | default (list 443 6443) -}}
{{- if not $cidrs }}
{{- $slice := lookup "discovery.k8s.io/v1" "EndpointSlice" "default" "kubernetes" }}
{{- range ($slice.endpoints | default list) }}
{{- range .addresses }}
{{- $cidrs = append $cidrs (printf "%s/32" .) }}
{{- end }}
{{- end }}
{{- end }}
{{- if $cidrs }}
- to:
    {{- range $cidrs }}
    - ipBlock: { cidr: {{ . }} }
    {{- end }}
  ports:
    {{- range $ports }}
    - port: {{ . }}
      protocol: TCP
    {{- end }}
{{- end }}
{{- end -}}
