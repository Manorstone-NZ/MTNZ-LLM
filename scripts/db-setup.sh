#!/bin/bash
set -e
echo "Starting PostgreSQL..."
docker compose up -d
echo "Waiting for PostgreSQL to be ready..."
until docker exec idd-knowledge-db pg_isready -U damian; do sleep 1; done
echo "PostgreSQL is ready."
echo "Running migrations..."
for f in db/migrations/*.sql; do
  echo "  Applying $f..."
  docker exec -i idd-knowledge-db psql -U damian -d idd_knowledge < "$f"
done
echo "Done."
