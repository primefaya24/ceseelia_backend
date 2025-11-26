# ===========================
# PrimeDine Node.js Deploy Script (Auto-Build + No-Cache)
# ===========================

# --- CONFIGURATION ---
$PemPath    = "C:\aws\pem\primehost-0.pem"             # Path to your .pem key
$EC2Host    = "ec2-user@3.215.232.243"                 # Your EC2 username and host
$RemotePath = "/home/ec2-user"                         # Where to upload image on EC2
$ProjectDir = "C:\GitHub\dinersxpress"                 # Path to project root
$ImageName  = "primedine-node"
$Tag        = "latest"
$ImageFile  = "node-image.tar"

# --- STEP 0: Compile Node.js source ---
Write-Host "[TS-BUILD] Compiling Node.js (TypeScript) project..." -ForegroundColor Cyan
Set-Location "$ProjectDir\node"

if (Test-Path "package.json") {
    if (Test-Path "dist") { Remove-Item -Recurse -Force "dist" }
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] npm build failed. Exiting..." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[ERROR] package.json not found in $ProjectDir\node" -ForegroundColor Red
    exit 1
}

# --- STEP 1: Build Docker image (no cache) ---
Write-Host "[DOCKER-BUILD] Building Docker image (no cache)..." -ForegroundColor Cyan
Set-Location "$ProjectDir"
docker build --no-cache -t ("{0}:{1}" -f $ImageName, $Tag) .\node

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Docker build failed. Exiting..." -ForegroundColor Red
    exit 1
}

# --- STEP 2: Save image to TAR file ---
Write-Host "[SAVE] Saving image to $ImageFile..." -ForegroundColor Cyan
docker save ("{0}:{1}" -f $ImageName, $Tag) -o "$ImageFile"

# --- STEP 3: Upload image to EC2 ---
Write-Host "[UPLOAD] Uploading image to EC2..." -ForegroundColor Cyan
scp -i "$PemPath" "$ImageFile" ("{0}:{1}/" -f $EC2Host, $RemotePath)

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] SCP upload failed. Exiting..." -ForegroundColor Red
    exit 1
}

# --- STEP 4: Load image and restart container on EC2 ---
Write-Host "[DEPLOY] Updating Node.js container on EC2..." -ForegroundColor Cyan

$RemoteCmd = "cd $RemotePath/primedine; docker load -i $RemotePath/$ImageFile; sudo docker compose up -d --force-recreate node; rm $RemotePath/$ImageFile"

cmd /c "ssh -i `"$PemPath`" $EC2Host `"$RemoteCmd`""

# --- STEP 5: Cleanup local TAR ---
Remove-Item -Path "$ImageFile" -Force

Write-Host "[DONE] Deployment complete! Node.js container updated successfully." -ForegroundColor Green
