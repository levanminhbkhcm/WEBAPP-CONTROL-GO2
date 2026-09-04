using System.Diagnostics;
using System.Net.Http;
using System.Text.RegularExpressions;

namespace WebAppLauncher;

internal static partial class Program
{
    private const string DefaultUrl = "http://localhost:3000/";

    private static Process? _serverProcess;
    private static bool _browserOpened;

    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.Title = "Unitree Web App";

        var appRoot = FindAppRoot(AppContext.BaseDirectory);
        if (appRoot is null)
        {
            Fail("Không tìm thấy package.json. Hãy đặt Run-WebApp.exe trong thư mục WEB APP.");
            return 1;
        }

        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            StopServer();
            Environment.Exit(0);
        };

        Console.WriteLine("UNITREE WEB APP");
        Console.WriteLine($"Thư mục: {appRoot}");

        var runner = ResolveNodeRunner();
        if (runner is null)
        {
            Fail("Không tìm thấy pnpm/npm/Node.js. Hãy cài Node.js 22 trở lên rồi chạy lại.");
            return 1;
        }

        if (!Directory.Exists(Path.Combine(appRoot, "node_modules")))
        {
            Console.WriteLine("Đang cài thư viện lần đầu...");
            var installCode = await RunCommand(appRoot, runner, runner.InstallArguments);
            if (installCode != 0)
            {
                Fail("Cài thư viện thất bại. Hãy mở Terminal và chạy: pnpm install");
                return installCode;
            }
        }

        Console.WriteLine("Đang khởi động web app...");
        _serverProcess = StartCommand(appRoot, runner, runner.DevArguments);
        _ = Task.Run(() => PipeOutput(_serverProcess.StandardOutput, false));
        _ = Task.Run(() => PipeOutput(_serverProcess.StandardError, true));

        await OpenBrowserWhenReady(DefaultUrl);

        Console.WriteLine();
        Console.WriteLine("Web app đang chạy.");
        Console.WriteLine($"Mở bằng trình duyệt: {DefaultUrl}");
        Console.WriteLine("Bấm Ctrl + C để dừng.");

        await _serverProcess.WaitForExitAsync();
        return _serverProcess.ExitCode;
    }

    private static string? FindAppRoot(string startDirectory)
    {
        var directory = new DirectoryInfo(startDirectory);

        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "package.json")) &&
                Directory.Exists(Path.Combine(directory.FullName, "app")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        return null;
    }

    private static Runner? ResolveNodeRunner()
    {
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var bundledNode = Path.Combine(
            userProfile,
            ".cache",
            "codex-runtimes",
            "codex-primary-runtime",
            "dependencies",
            "node",
            "bin");
        var bundledPnpm = Path.Combine(
            userProfile,
            ".cache",
            "codex-runtimes",
            "codex-primary-runtime",
            "dependencies",
            "bin",
            "fallback",
            "pnpm.cmd");

        if (File.Exists(bundledPnpm) && Directory.Exists(bundledNode))
        {
            return new Runner(
                "cmd.exe",
                $"/c \"\"{bundledPnpm}\" install --ignore-scripts\"",
                $"/c \"\"{bundledPnpm}\" dev\"",
                bundledNode);
        }

        var pnpm = FindOnPath("pnpm.cmd") ?? FindOnPath("pnpm.exe") ?? FindOnPath("pnpm");
        if (pnpm is not null)
        {
            return new Runner(
                "cmd.exe",
                $"/c \"\"{pnpm}\" install --ignore-scripts\"",
                $"/c \"\"{pnpm}\" dev\"",
                null);
        }

        var npm = FindOnPath("npm.cmd") ?? FindOnPath("npm.exe") ?? FindOnPath("npm");
        if (npm is not null)
        {
            return new Runner(
                "cmd.exe",
                $"/c \"\"{npm}\" install --ignore-scripts\"",
                $"/c \"\"{npm}\" run dev\"",
                null);
        }

        return null;
    }

    private static string? FindOnPath(string fileName)
    {
        var paths = (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);

        foreach (var path in paths)
        {
            var candidate = Path.Combine(path.Trim(), fileName);
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    private static Process StartCommand(string workingDirectory, Runner runner, string arguments)
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";

        if (runner.ExtraPath is not null)
        {
            path = $"{runner.ExtraPath}{Path.PathSeparator}{path}";
        }

        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = runner.FileName,
                Arguments = arguments,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = false,
            },
            EnableRaisingEvents = true,
        };
        process.StartInfo.Environment["PATH"] = path;
        process.Start();
        return process;
    }

    private static async Task<int> RunCommand(
        string workingDirectory,
        Runner runner,
        string command)
    {
        using var process = StartCommand(workingDirectory, runner, command);
        var stdout = Task.Run(() => PipeOutput(process.StandardOutput, false));
        var stderr = Task.Run(() => PipeOutput(process.StandardError, true));

        await process.WaitForExitAsync();
        await Task.WhenAll(stdout, stderr);
        return process.ExitCode;
    }

    private static async Task PipeOutput(StreamReader reader, bool isError)
    {
        while (await reader.ReadLineAsync() is { } line)
        {
            if (line.Contains("Local:", StringComparison.OrdinalIgnoreCase))
            {
                var match = LocalUrlRegex().Match(line);
                if (match.Success)
                {
                    _ = OpenBrowserOnce(match.Value);
                }
            }

            if (isError)
            {
                Console.Error.WriteLine(line);
            }
            else
            {
                Console.WriteLine(line);
            }
        }
    }

    private static async Task OpenBrowserWhenReady(string url)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };

        for (var attempt = 0; attempt < 60; attempt += 1)
        {
            try
            {
                using var response = await client.GetAsync(url);
                if (response.IsSuccessStatusCode)
                {
                    OpenBrowserOnce(url);
                    return;
                }
            }
            catch
            {
                // Server is still starting.
            }

            await Task.Delay(500);
        }

        OpenBrowserOnce(url);
    }

    private static bool OpenBrowserOnce(string url)
    {
        if (_browserOpened)
        {
            return false;
        }

        _browserOpened = true;
        Process.Start(new ProcessStartInfo
        {
            FileName = url,
            UseShellExecute = true,
        });
        return true;
    }

    private static void StopServer()
    {
        try
        {
            if (_serverProcess is { HasExited: false })
            {
                _serverProcess.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Ignore shutdown errors.
        }
    }

    private static void Fail(string message)
    {
        Console.Error.WriteLine(message);
        Console.WriteLine("Bấm Enter để đóng cửa sổ.");
        Console.ReadLine();
    }

    [GeneratedRegex(@"https?://[^\s]+", RegexOptions.Compiled)]
    private static partial Regex LocalUrlRegex();

    private sealed record Runner(
        string FileName,
        string InstallArguments,
        string DevArguments,
        string? ExtraPath);
}
