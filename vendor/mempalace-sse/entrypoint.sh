#!/bin/sh
set -e

PALACE_PATH="${MEMPALACE_PATH:-/data/palace}"

# Ensure the palace directory and ChromaDB collection exist
mkdir -p "$PALACE_PATH"
python -c "
import os, chromadb
path = os.environ.get('MEMPALACE_PATH', '/data/palace')
client = chromadb.PersistentClient(path=path)
client.get_or_create_collection('mempalace_drawers')
print(f'Palace ready at {path}')
"

exec python server.py
