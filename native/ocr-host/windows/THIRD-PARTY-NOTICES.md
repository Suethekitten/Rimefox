# Windows connector dependencies

Rimefox's own source is MIT licensed (the package-root LICENSE). The self-contained Windows binary also bundles Microsoft .NET and C#/WinRT assemblies; those components retain their own terms and notices.

- `licenses/dotnet-library-license.txt`: Microsoft .NET Library License, copied from the SDK distribution used to build this binary. Microsoft's [Windows license information](https://github.com/dotnet/core/blob/main/license-information-windows.md) specifically covers runtimes embedded in single-file Windows applications.
- `licenses/dotnet-MIT.txt` and `licenses/dotnet-third-party-notices.txt`: copied from the exact `Microsoft.NETCore.App.Runtime.<RID>` package selected by this build.
- `licenses/CsWinRT-MIT.txt`: Microsoft C#/WinRT license from [the upstream project](https://github.com/microsoft/CsWinRT/blob/master/LICENSE), applicable to the runtime and Windows API projection assemblies.
- `licenses/components.json`: identifies the bundled runtime and Windows projection versions; it contains no machine paths or credentials.

Windows.Media.Ocr itself is part of the user's Windows installation and is not redistributed in this package. No Windows language packs, PaddleOCR runtime or models are included.
