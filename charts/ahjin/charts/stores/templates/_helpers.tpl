{{- define "stores.labels" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/component: stores
app.kubernetes.io/part-of: ahjin
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/managed-by: {{ $root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" $root.Chart.Name $root.Chart.Version }}
{{- end -}}

{{- define "stores.selectorLabels" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
{{- end -}}

{{/*
The Helm values every provisioned store starts from (store-instance chart): this platform's
global settings (domain, TLS, ingress, NetworkPolicy switches) and the images to run. The
operator adds each store's name and host.
*/}}
{{- define "stores.baseValues" -}}
{{- $values := dict
  "global" .Values.global
  "store" (dict "wordpress" (dict "image" .Values.images.wordpress))
  "woo-mcp" (dict "image" .Values.images.wooMcp "networkPolicy" (dict "gatewayNamespace" .Release.Namespace "allowFromPods" (list (dict "app.kubernetes.io/name" "gateway")) "egress" (dict "toPods" (list (dict "podLabels" (dict "app.kubernetes.io/name" "wordpress") "port" 8080)))))
-}}
{{- $values | toJson -}}
{{- end -}}
