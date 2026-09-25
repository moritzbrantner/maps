{
  description = "Reproducible development shell for maps";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/4975466d324710c576dc11ad614684e6bd8cad8e";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };

          bunAsset =
            if system == "x86_64-linux" then
              {
                archive = "bun-linux-x64";
                hash = "sha256-lR7iruhV8IWVruxiJSJqKY0/6oOj3NZGXAnLzN9+hI8=";
              }
            else
              {
                archive = "bun-linux-aarch64";
                hash = "sha256-on/7Y6gxA3WDbg1vZorhf6jY0YuIw3yCHGUzGXOhmjs=";
              };

          bun = pkgs.stdenvNoCC.mkDerivation {
            pname = "bun";
            version = "1.3.14";
            src = pkgs.fetchurl {
              url = "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/${bunAsset.archive}.zip";
              inherit (bunAsset) hash;
            };
            nativeBuildInputs = [ pkgs.unzip ];
            dontUnpack = true;
            installPhase = ''
              mkdir -p "$out/bin"
              unzip -q "$src"
              install -m755 "${bunAsset.archive}/bun" "$out/bin/bun"
            '';
          };

          wasmBindgenAsset =
            if system == "x86_64-linux" then
              {
                target = "x86_64-unknown-linux-musl";
                hash = "sha256-tR8CCP3/g1FaeHvYq5rFhl7YTau2bQxwmVe7WXk8ZF8=";
              }
            else
              {
                target = "aarch64-unknown-linux-musl";
                hash = "sha256-B5cx3RvHeYwe+k8I/MRRMIJ8vMn/YKC0xgR9ZPxv0lw=";
              };

          wasmBindgen = pkgs.stdenvNoCC.mkDerivation {
            pname = "wasm-bindgen-cli";
            version = "0.2.128";
            src = pkgs.fetchurl {
              url = "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.128/wasm-bindgen-0.2.128-${wasmBindgenAsset.target}.tar.gz";
              inherit (wasmBindgenAsset) hash;
            };
            nativeBuildInputs = [
              pkgs.gnutar
              pkgs.gzip
            ];
            dontUnpack = true;
            installPhase = ''
              mkdir -p "$out/bin"
              tar -xzf "$src"
              install -m755 "wasm-bindgen-0.2.128-${wasmBindgenAsset.target}/wasm-bindgen" "$out/bin/wasm-bindgen"
            '';
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              bun
              pkgs.binaryen
              pkgs.git
              pkgs.nodejs_24
              pkgs.rustup
              wasmBindgen
            ];
          };
        }
      );
    };
}
