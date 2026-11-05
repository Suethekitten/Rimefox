// Native Messaging v1. stdout contains binary protocol frames only.
using System.Buffers.Binary;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

internal static class Program
{
    const string Version = "0.2.0-preview.1";
    const int MaxSide = 8192;
    static readonly Stream Input = Console.OpenStandardInput();
    static readonly Stream Output = Console.OpenStandardOutput();
    static readonly object WriteLock = new();
    static readonly object JobsLock = new();
    static readonly Dictionary<string, CancellationTokenSource> Jobs = new();
    static readonly SemaphoreSlim Queue = new(1);
    static readonly Regex IdPattern = new("^[A-Za-z0-9_-]{1,64}$", RegexOptions.CultureInvariant);

    static int Main(string[] args)
    {
        if (args.Contains("--version")) { Console.WriteLine($"rimefox-ocr-host {Version} (protocol 1)"); return 0; }
        if (args.Contains("--diagnose")) { Console.WriteLine(JsonSerializer.Serialize(Diagnose())); return 0; }
        if (args.Contains("--languages")) { Console.WriteLine(string.Join('\n', Languages())); return 0; }
        try
        {
            // Keep stdin responsive while WinRT recognition is running on the serial worker.
            var header = new byte[4];
            while (ReadExactly(header))
            {
                uint size = BinaryPrimitives.ReadUInt32LittleEndian(header);
                if (size == 0 || size > 64 * 1024 * 1024) break;
                var bytes = new byte[(int)size];
                if (!ReadExactly(bytes)) break;
                try
                {
                    using var json = JsonDocument.Parse(bytes);
                    Dispatch(json.RootElement);
                }
                catch (JsonException) { Error("r0", "bad_request", "invalid JSON"); }
            }
            return 0;
        }
        catch (IOException) { return 0; } // Browser closed the pipe.
        finally { lock (JobsLock) foreach (var job in Jobs.Values) job.Cancel(); }
    }

    static bool ReadExactly(byte[] bytes)
    {
        int offset = 0;
        while (offset < bytes.Length)
        {
            int count = Input.Read(bytes, offset, bytes.Length - offset);
            if (count == 0) return false;
            offset += count;
        }
        return true;
    }

    static void Send(object message, string id)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message);
        if (bytes.Length >= 1024 * 1024)
            bytes = JsonSerializer.SerializeToUtf8Bytes(Failure(id, "too_large", "result exceeds 1 MB"));
        lock (WriteLock)
        {
            var header = new byte[4];
            BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)bytes.Length);
            Output.Write(header);
            Output.Write(bytes);
            Output.Flush();
        }
    }

    static object Failure(string id, string code, string message) =>
        new { v = 1, id, type = "result", ok = false, error = new { code, message } };
    static void Error(string id, string code, string message) => Send(Failure(id, code, message), id);
    static string Text(JsonElement obj, string key) => obj.ValueKind == JsonValueKind.Object &&
        obj.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString()! : "";
    static int Number(JsonElement obj, string key) => obj.ValueKind == JsonValueKind.Object &&
        obj.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) ? number : 0;
    static string[] Languages() => OcrEngine.AvailableRecognizerLanguages.Select(l => l.LanguageTag).Take(64).ToArray();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern int GetCurrentPackageFullName(ref uint length, StringBuilder? name);
    static object Diagnose()
    {
        uint length = 0;
        bool packaged = GetCurrentPackageFullName(ref length, null) != 15700;
        string[] languages = [];
        string apiStatus = "unsupported", message = "";
        try { languages = Languages(); apiStatus = languages.Length > 0 ? "ready" : "language_unavailable"; }
        catch (Exception e) { message = e.GetType().Name + ": Windows OCR is unavailable in this environment"; }
        return new { version = Version, protocol = 1, platform = "win32", architecture = RuntimeInformation.ProcessArchitecture.ToString(),
            osVersion = Environment.OSVersion.Version.ToString(), packaged, apiStatus, languages, message,
            compatibility = "Unpackaged Windows OCR preview; Microsoft documents desktop support for apps with package identity. Clean-machine validation is still required." };
    }

    static void Dispatch(JsonElement message)
    {
        string id = Text(message, "id");
        if (!IdPattern.IsMatch(id)) { Error("r0", "bad_request", "invalid request id"); return; }
        if (Number(message, "v") != 1) { Error(id, "unsupported_protocol", "expected protocol 1"); return; }
        switch (Text(message, "type"))
        {
            case "hello":
                string[] langs = []; string status, diagnostic = "";
                try { langs = Languages(); status = langs.Length > 0 ? "ready" : "language_unavailable"; }
                catch { status = "unsupported"; diagnostic = "Windows OCR cannot be activated in this environment; run the connector with --diagnose."; }
                Send(new { v = 1, id, type = "hello",
                    component = new { version = Version, platform = "win32", protocols = new[] { 1 } },
                    backends = new object[] {
                        new { id = "system", name = "Windows OCR", version = Environment.OSVersion.Version.ToString(),
                            status, message = diagnostic, model = "Windows.Media.Ocr:" + Version + ":" + (Match("zh-Hans", langs) ?? Match("zh-Hant", langs) ?? Match("en", langs) ?? Match(CultureInfo.CurrentUICulture.Name, langs) ?? "none"), languages = langs },
                        new { id = "paddle", name = "PaddleOCR", status = "engine_missing" }
                    } }, id);
                break;
            case "cancel":
                lock (JobsLock)
                    if (Jobs.TryGetValue(Text(message, "target"), out var job)) job.Cancel();
                break;
            case "recognize":
                lock (JobsLock)
                {
                    if (Jobs.ContainsKey(id)) { Error(id, "bad_request", "duplicate request id"); return; }
                    if (Jobs.Count >= 8) { Error(id, "busy", "recognition queue is full"); return; }
                    var token = new CancellationTokenSource();
                    Jobs.Add(id, token);
                    var copy = message.Clone();
                    _ = Task.Run(() => RunJob(copy, id, token));
                }
                break;
            default: Error(id, "bad_request", "unknown message type"); break;
        }
    }

    static async Task RunJob(JsonElement message, string id, CancellationTokenSource source)
    {
        bool entered = false;
        try
        {
            await Queue.WaitAsync(source.Token);
            entered = true;
            var result = await Recognize(message, id, source.Token);
            source.Token.ThrowIfCancellationRequested();
            Send(result, id);
        }
        catch (OperationCanceledException) { Error(id, "cancelled", "cancelled"); }
        catch (OcrFailure e) { Error(id, e.Code, e.Message); }
        catch (Exception e)
        {
            if (source.IsCancellationRequested) Error(id, "cancelled", "cancelled");
            else if (e is ArgumentException or FormatException or JsonException)
                Error(id, "bad_request", "invalid image or request");
            else
            {
                Console.Error.WriteLine($"[rimefox-ocr] {e.GetType().Name}: {e.Message}");
                Error(id, "internal", "Windows OCR failed");
            }
        }
        finally
        {
            lock (JobsLock) { Jobs.Remove(id); source.Dispose(); }
            if (entered) Queue.Release();
        }
    }

    // Preserve Chinese script distinctions: zh-Hant must never select a Hans model.
    static string Canonical(string tag)
    {
        var lower = tag.ToLowerInvariant();
        if (lower is "zh-cn" or "zh-sg") return "zh-hans";
        if (lower is "zh-tw" or "zh-hk" or "zh-mo") return "zh-hant";
        return lower;
    }
    static string? Match(string tag, string[] installed)
    {
        var wanted = Canonical(tag);
        return installed.FirstOrDefault(l => Canonical(l) == wanted) ??
            installed.FirstOrDefault(l => Canonical(l).StartsWith(wanted + "-", StringComparison.Ordinal));
    }
    static Language SelectLanguage(JsonElement message)
    {
        var installed = Languages();
        string[] requested = [];
        if (message.TryGetProperty("languages", out var list))
        {
            if (list.ValueKind != JsonValueKind.Array || list.GetArrayLength() > 8)
                throw new OcrFailure("bad_request", "invalid languages");
            requested = list.EnumerateArray().Select(l => l.ValueKind == JsonValueKind.String ? l.GetString()! : "").ToArray();
            if (requested.Any(l => !Regex.IsMatch(l, "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$")))
                throw new OcrFailure("bad_request", "invalid language tag");
        }
        var preferences = requested.Length > 0 ? requested : ["zh-Hans", "zh-Hant", "en", CultureInfo.CurrentUICulture.Name];
        var selected = preferences.Select(l => Match(l, installed)).FirstOrDefault(l => l != null);
        if (selected == null) throw new OcrFailure("language_unavailable", "install a matching Windows OCR language pack");
        return new Language(selected);
    }

    static async Task<object> Recognize(JsonElement message, string id, CancellationToken token)
    {
        var clock = Stopwatch.StartNew();
        string backend = Text(message, "backend");
        if (backend == "paddle") throw new OcrFailure("engine_missing", "PaddleOCR engine pack is not installed");
        if (backend != "system") throw new OcrFailure("bad_request", "unknown backend");
        if (!message.TryGetProperty("image", out var image)) throw new OcrFailure("bad_request", "missing image");
        string mime = Text(image, "mime"), data = Text(image, "data");
        int width = Number(image, "width"), height = Number(image, "height");
        if (mime is not ("image/png" or "image/jpeg") || width < 1 || height < 1 || width > MaxSide || height > MaxSide)
            throw new OcrFailure("bad_request", "invalid image dimensions or MIME type");
        if (data.Length > 32 * 1024 * 1024) throw new OcrFailure("too_large", "image exceeds base64 limit");
        if (data.Length == 0 || data.Length % 4 != 0 || !Regex.IsMatch(data, "^[A-Za-z0-9+/]*={0,2}$"))
            throw new OcrFailure("bad_request", "invalid base64 image");
        var language = SelectLanguage(message);
        var engine = OcrEngine.TryCreateFromLanguage(language) ?? throw new OcrFailure("language_unavailable", "OCR language unavailable");
        using var stream = new InMemoryRandomAccessStream();
        using (var writer = new DataWriter(stream))
        {
            writer.WriteBytes(Convert.FromBase64String(data));
            await writer.StoreAsync().AsTask(token);
            writer.DetachStream();
        }
        stream.Seek(0);
        BitmapDecoder decoder;
        try { decoder = await BitmapDecoder.CreateAsync(stream).AsTask(token); }
        catch (Exception e) when (e is not OperationCanceledException) { throw new OcrFailure("bad_request", "image cannot be decoded"); }
        if (decoder.PixelWidth != width || decoder.PixelHeight != height ||
            (mime == "image/png" && decoder.DecoderInformation.CodecId != BitmapDecoder.PngDecoderId) ||
            (mime == "image/jpeg" && decoder.DecoderInformation.CodecId != BitmapDecoder.JpegDecoderId))
            throw new OcrFailure("bad_request", "decoded image does not match dimensions or MIME type");
        double scale = Math.Min(1, (double)OcrEngine.MaxImageDimension / Math.Max(width, height));
        var transform = new BitmapTransform { ScaledWidth = (uint)Math.Max(1, Math.Floor(width * scale)),
            ScaledHeight = (uint)Math.Max(1, Math.Floor(height * scale)), InterpolationMode = BitmapInterpolationMode.Fant };
        using var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied,
            transform, ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.DoNotColorManage).AsTask(token);
        var result = await engine.RecognizeAsync(bitmap).AsTask(token);
        var lines = new List<object>();
        int chars = 0;
        foreach (var line in result.Lines)
        {
            token.ThrowIfCancellationRequested();
            string text = CleanCjk(line.Text);
            if (string.IsNullOrWhiteSpace(text) || line.Words.Count == 0) continue;
            chars += text.Length;
            if (lines.Count >= 5000 || text.Length > 4000 || chars > 300000)
                throw new OcrFailure("too_large", "recognized text exceeds protocol limits");
            double left = line.Words.Min(w => w.BoundingRect.Left), top = line.Words.Min(w => w.BoundingRect.Top);
            double right = line.Words.Max(w => w.BoundingRect.Right), bottom = line.Words.Max(w => w.BoundingRect.Bottom);
            double sx = (double)width / bitmap.PixelWidth, sy = (double)height / bitmap.PixelHeight;
            lines.Add(new { text, box = new[] { left * sx, top * sy, (right - left) * sx, (bottom - top) * sy }
                .Select(n => Math.Round(n, 2)).ToArray() });
        }
        return new { v = 1, id, type = "result", ok = true, backend = "system",
            engine = new { name = "Windows OCR", version = Environment.OSVersion.Version.ToString(), model = "Windows.Media.Ocr:" + Version + ":" + language.LanguageTag },
            durationMs = clock.ElapsedMilliseconds, lines };
    }

    static bool Cjk(Rune rune) => rune.Value is >= 0x3400 and <= 0x9fff or >= 0xf900 and <= 0xfaff or >= 0x20000 and <= 0x323af;
    static string CleanCjk(string text)
    {
        var runes = text.EnumerateRunes().ToArray();
        var result = new StringBuilder();
        for (int i = 0; i < runes.Length; i++)
        {
            if (Rune.IsWhiteSpace(runes[i]) && i > 0 && Cjk(runes[i - 1]))
            {
                int end = i;
                while (end < runes.Length && Rune.IsWhiteSpace(runes[end])) end++;
                if (end < runes.Length && Cjk(runes[end])) { i = end - 1; continue; }
            }
            result.Append(runes[i]);
        }
        return result.ToString();
    }

    sealed class OcrFailure(string code, string message) : Exception(message) { public string Code { get; } = code; }
}
