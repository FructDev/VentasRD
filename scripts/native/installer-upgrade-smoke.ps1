param([string]$FromVersion='0.1.3',[string]$ToVersion='0.1.4')
$ErrorActionPreference='Stop'
$repository=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$uninstallKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\VentaRD QA'
$productKey='HKCU:\Software\ventard\VentaRD QA'
if((Test-Path -LiteralPath $uninstallKey) -or (Test-Path -LiteralPath $productKey)){throw 'INSTALLER_SMOKE_REFUSES_EXISTING_INSTALLATION'}
function Get-Package([string]$version){
 if($version -notmatch '^\d+\.\d+\.\d+$'){throw 'INSTALLER_SMOKE_VERSION_INVALID'}
 $folder=Join-Path $repository "scratch/windows-qa-distribution/$version"
 $manifest=Get-Content -LiteralPath (Join-Path $folder 'package.json') -Raw | ConvertFrom-Json
 if($manifest.identifier -ne 'com.ventard.pos.qa' -or $manifest.channel -ne 'STAGING_QA_A_B_ONLY' -or $manifest.version -ne $version -or $manifest.validation -like 'REJECTED*'){throw 'INSTALLER_SMOKE_PACKAGE_INVALID'}
 if([IO.Path]::GetFileName($manifest.installer.file) -ne $manifest.installer.file){throw 'INSTALLER_SMOKE_FILE_INVALID'}
 $file=Join-Path $folder $manifest.installer.file
 if((Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant() -ne $manifest.installer.sha256){throw 'INSTALLER_SMOKE_HASH_INVALID'}
 return $file
}
$from=Get-Package $FromVersion
$to=Get-Package $ToVersion
$runId=[guid]::NewGuid().ToString('N')
$target=Join-Path $repository "scratch/installer-acceptance-$runId"
New-Item -ItemType Directory -Path $target | Out-Null
$target=(Resolve-Path -LiteralPath $target).Path
if(-not $target.StartsWith((Join-Path $repository 'scratch/installer-acceptance-'),[StringComparison]::OrdinalIgnoreCase)){throw 'INSTALLER_SMOKE_TARGET_INVALID'}
$profile=Join-Path $env:TEMP "ventard-native-spike-installer-$runId"
New-Item -ItemType Directory -Path $profile | Out-Null
$previousRoot=$env:VENTARD_QA_FIXTURE_ROOT
$previousSmoke=$env:VENTARD_QA_SHELL_SMOKE
function Invoke-Setup([string]$file){
 $p=Start-Process -FilePath $file -ArgumentList "/S /NS /UPDATE /D=$target" -WindowStyle Hidden -PassThru
 try{if(-not $p.WaitForExit(30000)){throw 'INSTALLER_SMOKE_SETUP_TIMEOUT'};return $p.ExitCode}finally{$p.Dispose()}
}
function Assert-Installed([string]$version){
 $data=Get-ItemProperty -LiteralPath $uninstallKey
 if($data.DisplayVersion -ne $version -or $data.InstallLocation.Trim('"') -ne $target){throw 'INSTALLER_SMOKE_REGISTRY_MISMATCH'}
 $binary=Join-Path $target 'VentaRD-QA.exe'
 if((Get-Item -LiteralPath $binary).VersionInfo.ProductVersion -ne $version){throw 'INSTALLER_SMOKE_BINARY_VERSION_MISMATCH'}
 $manifest=Get-Content -LiteralPath (Join-Path $repository "scratch/windows-qa-distribution/$version/package.json") -Raw|ConvertFrom-Json
 if((Get-FileHash -LiteralPath $binary).Hash.ToLowerInvariant() -ne $manifest.binarySha256){throw 'INSTALLER_SMOKE_INSTALLED_HASH_MISMATCH'}
 return $binary
}
function Start-Owned-Smoke([string]$binary){
 $env:VENTARD_QA_FIXTURE_ROOT=$profile
 $env:VENTARD_QA_SHELL_SMOKE='1'
 $stdout=Join-Path $profile ('stdout-'+[guid]::NewGuid().ToString('N')+'.log')
 $p=Start-Process -FilePath $binary -WorkingDirectory $target -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError ($stdout+'.err')
 try{
  $deadline=[DateTime]::UtcNow.AddSeconds(25)
  do{$p.Refresh();$ready=Select-String -LiteralPath $stdout -SimpleMatch 'NATIVE_UI_READY' -Quiet -ErrorAction SilentlyContinue
   if($ready -and (Test-Path -LiteralPath (Join-Path $profile 'vault/native-access/public-staging-config.json'))){return}
   if($p.HasExited){throw 'INSTALLER_SMOKE_APP_EXITED'};Start-Sleep -Milliseconds 100
  }while([DateTime]::UtcNow -lt $deadline)
  throw 'INSTALLER_SMOKE_APP_NOT_READY'
 }finally{$p.Refresh();if(-not $p.HasExited){$p.Kill();$p.WaitForExit()};$p.Dispose()}
}
try{
 if((Invoke-Setup $from) -ne 0){throw 'INSTALLER_SMOKE_FIRST_INSTALL_FAILED'}
 $binary=Assert-Installed $FromVersion
 Start-Owned-Smoke $binary
 $config=Join-Path $profile 'vault/native-access/public-staging-config.json'
 $configHash=(Get-FileHash -LiteralPath $config).Hash
 $preserved=Join-Path $profile 'vault/native-access/installer-preserved.dat'
 $preservedBytes=New-Object byte[] 512
 $random=[Security.Cryptography.RandomNumberGenerator]::Create()
 try{$random.GetBytes($preservedBytes)}finally{$random.Dispose()}
 [IO.File]::WriteAllBytes($preserved,$preservedBytes)
 $preservedHash=(Get-FileHash -LiteralPath $preserved).Hash
 Write-Output "PASS QA installer $FromVersion, installed WebView2 startup and public config seeded"
 if((Invoke-Setup $to) -ne 0){throw 'INSTALLER_SMOKE_UPGRADE_FAILED'}
 $binary=Assert-Installed $ToVersion
 Start-Owned-Smoke $binary
 if((Get-FileHash -LiteralPath $config).Hash -ne $configHash -or (Get-FileHash -LiteralPath $preserved).Hash -ne $preservedHash){throw 'INSTALLER_SMOKE_DATA_CHANGED'}
 Write-Output "PASS upgrade $FromVersion -> $ToVersion, same config and preserved file hashes"
 $downgrade=Invoke-Setup $from
 $null=Assert-Installed $ToVersion
 if($downgrade -eq 0){throw 'INSTALLER_SMOKE_DOWNGRADE_NOT_REJECTED'}
 Write-Output 'PASS older installer rejected without changing installed version'
 # Remove only this test's installation, explicitly preserving AppData. The
 # generated uninstaller was checked to guard AppData deletion with /UPDATE.
 $uninstaller=(Resolve-Path -LiteralPath (Join-Path $target 'uninstall.exe')).Path
 if([IO.Path]::GetDirectoryName($uninstaller) -ne $target){throw 'INSTALLER_SMOKE_UNINSTALL_TARGET_INVALID'}
 $p=Start-Process -FilePath $uninstaller -ArgumentList "/S /UPDATE _?=$target" -WindowStyle Hidden -PassThru
 try{if(-not $p.WaitForExit(30000) -or $p.ExitCode -ne 0){throw 'INSTALLER_SMOKE_CLEANUP_FAILED'}}finally{$p.Dispose()}
 if(Test-Path -LiteralPath $uninstallKey){throw 'INSTALLER_SMOKE_REGISTRY_NOT_CLEANED'}
 $created=Get-Item -LiteralPath $productKey -ErrorAction SilentlyContinue
 if($null -ne $created){if($created.GetValue('') -ne $target -or $created.SubKeyCount -ne 0){throw 'INSTALLER_SMOKE_PRODUCT_KEY_CHANGED'};Remove-Item -LiteralPath $productKey -Force}
 $result=[pscustomobject]@{status='QA_INSTALLER_UPGRADE_SMOKE_PASS';from=$FromVersion;to=$ToVersion;profileConfigPreserved=$true;opaqueFilePreserved=$true;downgradeRejected=$true;testInstallationRemoved=$true;remoteWrites=$false}
 $result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $target 'result.json') -Encoding utf8
 $result|ConvertTo-Json
}finally{$env:VENTARD_QA_FIXTURE_ROOT=$previousRoot;$env:VENTARD_QA_SHELL_SMOKE=$previousSmoke}
