#!/bin/sh
# Install git hooks for this project
cp scripts/pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-push
echo "Git hooks installed ✅"
