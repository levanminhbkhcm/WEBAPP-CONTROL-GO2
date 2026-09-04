# Run-WebApp.exe

Launcher Windows cho web app Unitree.

Build:

```powershell
dotnet publish .\tools\WebAppLauncher\WebAppLauncher.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o .
```

Chạy:

```powershell
.\Run-WebApp.exe
```
