{{- define "eventflow.labels" -}}
app.kubernetes.io/part-of: eventflow
app.kubernetes.io/name: {{ . | quote }}
{{- end -}}

{{- define "eventflow.env" -}}
- { name: PUBLIC_ORIGIN, value: {{ .Values.publicOrigin | quote }} }
- { name: KEYCLOAK_URL, value: {{ .Values.identityOrigin | quote }} }
- { name: OIDC_ISSUER, value: {{ printf "%s/realms/eventflow" .Values.identityOrigin | quote }} }
- { name: OIDC_CLIENT_ID, value: eventflow-bff }
- { name: EVENTFLOW_HTTP_CONCURRENCY, value: {{ .Values.httpLimits.serviceConcurrent | quote }} }
- { name: EVENTFLOW_API_REQUESTS, value: {{ .Values.httpLimits.apiRequests | quote }} }
- { name: EVENTFLOW_SSR_REQUESTS, value: {{ .Values.httpLimits.ssrRequests | quote }} }
- { name: EVENTFLOW_API_CONCURRENCY, value: {{ .Values.httpLimits.apiConcurrent | quote }} }
- { name: EVENTFLOW_SSR_CONCURRENCY, value: {{ .Values.httpLimits.ssrConcurrent | quote }} }
- { name: EVENTFLOW_STREAM_REQUESTS, value: {{ .Values.httpLimits.streamRequests | quote }} }
- { name: EVENTFLOW_STREAM_CONCURRENCY, value: {{ .Values.httpLimits.streamConcurrent | quote }} }
- { name: CATALOG_URL, value: 'http://catalog:4001' }
- { name: BFF_URL, value: 'http://bff:4000' }
- { name: BOOKING_URL, value: 'http://booking:4002' }
- { name: PAYMENTS_URL, value: 'http://payments:4003' }
- { name: TICKETS_URL, value: 'http://tickets:4004' }
- { name: S3_ENDPOINT, value: 'http://s3:8333' }
- { name: PAYMENT_PROVIDER, value: fake }
- { name: MAILPIT_SMTP_HOST, value: mailpit }
- { name: MAILPIT_SMTP_PORT, value: '1025' }
- { name: MAIL_DELIVERY_DISABLED, value: 'true' }
- { name: EVENTFLOW_LOG_REQUESTS, value: '0' }
{{- end -}}

{{- define "eventflow.secrets" -}}
{{- range . }}
- name: {{ . }}
  valueFrom:
    secretKeyRef: { name: eventflow-runtime, key: {{ . }} }
{{- end }}
{{- end -}}

{{- define "eventflow.identityProxy" -}}
- name: identity-proxy
  image: {{ required "image is required" .Values.image | quote }}
  imagePullPolicy: Never
  restartPolicy: Always
  command: [node, /opt/eventflow/identity-proxy.mjs]
  env:
    - { name: KEYCLOAK_URL, value: {{ .Values.identityOrigin | quote }} }
  volumeMounts: [{ name: cluster-scripts, mountPath: /opt/eventflow, readOnly: true }]
  resources:
    requests: { cpu: 15m, memory: 32Mi }
    limits: { memory: 96Mi }
  startupProbe:
    exec:
      command: [node, -e, "const u=new URL(process.env.KEYCLOAK_URL);require('node:net').connect(u.port,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"]
    periodSeconds: 2
    failureThreshold: 15
{{- end -}}
