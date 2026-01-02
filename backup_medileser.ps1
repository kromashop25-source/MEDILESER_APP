$ErrorActionPreference = "Stop"

# Ajusta rutas si tu instalación difiere
$mysqldump = "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqldump.exe"

$backupDir = "C:\BACKUP_BD_MEDILESER_APP"
$logDir    = Join-Path $backupDir "logs"

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir    | Out-Null

$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$outFile   = Join-Path $backupDir "medileser_app_$timestamp.sql"
$logFile   = Join-Path $logDir    "backup_$timestamp.log"

# Comando mysqldump: consistente con app corriendo (InnoDB) y con objetos extra
& $mysqldump `
  --login-path=medileser_backup `
  --databases medileser_app `
  --single-transaction `
  --skip-lock-tables `
  --routines --events --triggers `
  --default-character-set=utf8mb4 `
  --set-gtid-purged=OFF `
  --hex-blob `
  --quick `
  --result-file="$outFile" 2>&1 | Tee-Object -FilePath $logFile

# Rotación: borrar backups de más de 14 días (ajusta a tu política)
Get-ChildItem -Path $backupDir -Filter "medileser_app_*.sql" |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-15) } |
  Remove-Item -Force

# Validación básica: archivo no vacío
if ((Get-Item $outFile).Length -lt 1024) {
  throw "Backup generado demasiado pequeño (<1KB). Revisar log: $logFile"
}
