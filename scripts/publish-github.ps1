# NEXOFIS — Script seguro de publicação no GitHub (Windows PowerShell)
# Repositório alvo padrão: https://github.com/devdudumuniz/NEXOFIS.git
# Não usa --force e executa testes, lint e build antes de commitar.

param(
  [string]$CommitMessage = "feat: atualiza NEXOFIS com status de contrato, Top 5 órgãos de risco e módulos de produção",
  [string]$RepoUrl = "https://github.com/devdudumuniz/NEXOFIS.git",
  [string]$Branch = "main",
  [switch]$Push
)

$ErrorActionPreference = "Stop"

Write-Host "==> [1/5] Executando testes unitários..." -ForegroundColor Cyan
npx --yes tsx --test src/lib/*.test.ts

Write-Host "==> [2/5] Executando verificação TypeScript (npm run lint)..." -ForegroundColor Cyan
npm run lint

Write-Host "==> [3/5] Executando build de produção (npm run build)..." -ForegroundColor Cyan
npm run build

Write-Host "==> [4/5] Configurando repositório Git local..." -ForegroundColor Cyan
if (-not (Test-Path ".git")) {
  git init -b $Branch
}

$existingOrigin = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0 -and $existingOrigin) {
  git remote set-url origin $RepoUrl
} else {
  git remote add origin $RepoUrl
}

Write-Host "==> [5/5] Verificando alterações e segredos..." -ForegroundColor Cyan
git add -A

$stagedDiff = git diff --cached
if ($stagedDiff -match 'AIza[0-9A-Za-z_-]{35}|ghp_[0-9A-Za-z]{36}|sk-[0-9A-Za-z]{20,}') {
  throw "Possível chave de API ou token literal detectado no diff staged. Abortando."
}

git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m $CommitMessage
} else {
  Write-Host "Nenhuma alteração pendente para commit." -ForegroundColor Yellow
}

if ($Push) {
  git push -u origin $Branch
} else {
  Write-Host "Commit concluído. Para publicar no GitHub execute:" -ForegroundColor Green
  Write-Host "  git push -u origin $Branch"
}
