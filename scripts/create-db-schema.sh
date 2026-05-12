#!/usr/bin/env sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required"
  echo "Example: export DATABASE_URL=postgres://postgres:abcd1234@localhost:5432/weatherindoubt6_development"
  exit 1
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/create-db-schema.sql"

echo "Schema creation completed."
