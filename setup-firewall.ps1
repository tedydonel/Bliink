# Bliink Firewall Setup - Run as Administrator
# This script adds Windows Firewall rules for Bliink device discovery (UDP port 9001)

$ErrorActionPreference = "Stop"

Write-Host "Setting up Bliink firewall rules..." -ForegroundColor Cyan

# Remove old rules if they exist
netsh advfirewall firewall delete rule name="Bliink Discovery UDP In" 2>$null
netsh advfirewall firewall delete rule name="Bliink Discovery UDP Out" 2>$null

# Add inbound rule for UDP discovery
netsh advfirewall firewall add rule name="Bliink Discovery UDP In" dir=in action=allow protocol=UDP localport=9001
Write-Host "  Added inbound UDP rule for port 9001" -ForegroundColor Green

# Add outbound rule for UDP broadcast
netsh advfirewall firewall add rule name="Bliink Discovery UDP Out" dir=out action=allow protocol=UDP remoteport=9001
Write-Host "  Added outbound UDP rule for port 9001" -ForegroundColor Green

# Add TCP rule for file transfers (dynamic ports)
netsh advfirewall firewall delete rule name="Bliink Transfer TCP In" 2>$null
netsh advfirewall firewall add rule name="Bliink Transfer TCP In" dir=in action=allow protocol=TCP localport=49152-65535 program=any
Write-Host "  Added inbound TCP rule for file transfers" -ForegroundColor Green

Write-Host ""
Write-Host "Firewall rules configured successfully!" -ForegroundColor Green
Write-Host "You can now use Bliink to discover devices on your network." -ForegroundColor White
