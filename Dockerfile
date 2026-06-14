FROM node:20-alpine
WORKDIR /app
COPY . .
# Reports are ephemeral on a host; delivery is via email or Airtable status.
CMD ["node", "src/run.js", "--watch"]
