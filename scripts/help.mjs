console.log(`EventFlow development commands

pnpm env:init          Generate local credentials; preserve an existing .env
pnpm env:postgres-port PORT  Change a reserved PostgreSQL host port while preserving data
pnpm infra:up          Start local dependencies and wait for health checks
pnpm infra:down        Stop dependencies; preserve project data volumes
pnpm infra:status      Show dependency status
pnpm identity:seed     Configure local Keycloak and demo accounts
pnpm db:migrate        Apply service database migrations
pnpm dev               Start applications behind the shared local origin
pnpm check             Repository policy, boundaries, format, lint, types and unit tests
pnpm build             Build every workspace
pnpm test:smoke        Launch and check all seven built applications
pnpm test:infra        Test actual local dependencies and database isolation
pnpm test:catalog      Test access, schedules, covers and public catalog in isolated databases
pnpm test:publication  Test RabbitMQ publication, recovery, idempotency and sales windows
pnpm test:booking      Test reservation races, expiry, cancellation and restart recovery
pnpm test:payments     Test payments, refunds, identity, webhooks and crash recovery locally
pnpm test:tickets      Test ticket issuance, redelivery and admission locally
pnpm test:stripe       Verify the real Stripe sandbox (test keys and network access required)
pnpm payments:reconcile --list  List payments and refunds that require operator review
pnpm test:load         Run a 10-minute local k6 baseline; synthetic isolated data only
pnpm test:load --smoke Run a 10-second CI load check; results stay in work/load
pnpm test:load --peak | --peak-replicas  Compare one and three Booking instances
pnpm test:identity     Test real Keycloak login, sessions, CSRF and token validation
pnpm test:e2e          Run the full browser journey against built applications
pnpm browser:install   Install the Chromium browser used by identity and E2E tests
pnpm storybook         Open UI component development server on port 6006
pnpm storybook:build   Build the UI component gallery
pnpm test:spikes       Check Prisma concurrency and fake payment cancellation
pnpm observability up|down|status|check  Manage the local Collector, Tempo, Prometheus and Grafana
pnpm test:telemetry    Verify real traces, metrics, dashboards and dependency recovery
pnpm test:telemetry-load [--smoke]  Compare telemetry off/on; full run uses the same CPU core
pnpm tools:setup       Install checksum-pinned local quality tools
pnpm check:workflow    Validate GitHub Actions syntax
pnpm check:secrets     Scan Git history and tracked working files
pnpm audit:runtime     Audit production dependencies; reject high/critical findings
pnpm ci:local          Run all local gates, including fake payments (Docker required)
pnpm release build    Build the staged Git snapshot and save its local image manifest
pnpm release deploy staging ID | promote ID | rollback ENV
pnpm release backup ENV | restore ID | monitor ENV | status ENV | stop ENV
pnpm release telemetry staging|demo on|off  Configure export for the next deployment
pnpm test:release seed staging|cluster | mark staging | verify staging|recovery|cluster
pnpm cluster check | status
pnpm cluster up ID [single|replicas|autoscale]  Deploy an image to the isolated local k3d cluster

Runtime: Node.js 24.22.1, pnpm 10.34.9
Storefront: http://127.0.0.1:18000
Organizer: http://127.0.0.1:18000/organizer/
Local demo credentials: work/local/demo-users.json (never committed)
Backend health: http://127.0.0.1:4000/health/ready (services: 4001–4004)
`);
