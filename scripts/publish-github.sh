#!/usr/bin/env bash
set -euo pipefail

# NEXOFIS — Script seguro de publicação no GitHub (Linux / macOS / WSL)
# Repositório alvo padrão: https://github.com/devdudumuniz/NEXOFIS.git
# Não usa --force e executa verificações obrigatórias antes do commit/push.

REPO_URL="${NEXOFIS_REPO_URL:-https://github.com/devdudumuniz/NEXOFIS.git}"
BRANCH="${NEXOFIS_BRANCH:-main}"
COMMIT_MSG="${1:-feat: atualiza NEXOFIS com status de contrato, Top 5 órgãos de risco e módulos de produção}"

echo "==> [1/6] Verificando segredos acidentais antes de versionar..."
if git ls-files 2>/dev/null | grep -qE '(^\.env$|^\.env\.local$)'; then
  echo "ERRO: Arquivo .env está rastreado pelo Git. Remova com 'git rm --cached .env' antes de publicar." >&2
  exit 1
fi

echo "==> [2/6] Executando testes unitários (node:test via tsx)..."
npx --yes tsx --test src/lib/*.test.ts

echo "==> [3/6] Executando verificação TypeScript (npm run lint)..."
npm run lint

echo "==> [4/6] Executando build de produção (npm run build)..."
npm run build

echo "==> [5/6] Preparando repositório Git local (sem --force)..."
if [ ! -d .git ]; then
  git init -b "$BRANCH"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

echo "==> [6/6] Preparando staging e verificando alterações..."
git add -A
if git diff --cached --quiet; then
  echo "Nenhuma alteração pendente para commit."
else
  # Varredura simples contra chaves literais em arquivos staged
  if git diff --cached | grep -E 'AIza[0-9A-Za-z_-]{35}|ghp_[0-9A-Za-z]{36}|sk-[0-9A-Za-z]{20,}' >/dev/null 2>&1; then
    echo "ERRO: Possível chave de API ou token detectado no diff staged. Abortando." >&2
    exit 1
  fi
  git commit -m "$COMMIT_MSG"
fi

echo "Pronto para enviar ao GitHub:"
echo "  git push -u origin $BRANCH"
if [ "${NEXOFIS_AUTO_PUSH:-false}" = "true" ]; then
  git push -u origin "$BRANCH"
else
  echo "Defina NEXOFIS_AUTO_PUSH=true para executar o push automaticamente."
fi
