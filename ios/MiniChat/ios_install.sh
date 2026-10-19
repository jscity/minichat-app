#!/bin/sh
# 构建「小红」（MiniChat），用临时 UDID 证书重签名，经局域网装到已配对的 iPhone。
# 加 --ota 则改为发布到 https://apps.home.xtvv.com（服务器管理/30_应用服务/app-distribution）。
# 证书默认读取 服务器管理/99_敏感资料_不进同步/临时UDID证书-至2027-10-09/（用途见该目录 README）；
# 也可用 MINICHAT_P12、MINICHAT_P12_PASSWORD、MINICHAT_PROFILE 覆盖。证书与密码不入库。
# 签名身份放在单独的临时钥匙串，不改登录钥匙串。做法与 玄武计划/apps/ios/Anchor/ios_install.sh 相同。
set -eu
MODE=${1:-device}
OTA_PUBLISH=${OTA_PUBLISH:-"$HOME/Documents/服务器管理/30_应用服务/app-distribution/ota-publish.sh"}
cd "$(dirname "$0")"
CERT_DIR=${MINICHAT_CERT_DIR:-"$HOME/Documents/服务器管理/99_敏感资料_不进同步/临时UDID证书-至2027-10-09"}
MINICHAT_P12=${MINICHAT_P12:-"$CERT_DIR/证书文件.p12"}
MINICHAT_PROFILE=${MINICHAT_PROFILE:-"$CERT_DIR/描述文件.mobileprovision"}
# 密码.txt 可能写成「密码：xxx」，只取冒号后的部分。
MINICHAT_P12_PASSWORD=${MINICHAT_P12_PASSWORD:-$(sed 's/.*[:：]//' "$CERT_DIR/密码.txt" 2>/dev/null | tr -d '[:space:]')}
[ -f "$MINICHAT_P12" ] && [ -f "$MINICHAT_PROFILE" ] && [ -n "$MINICHAT_P12_PASSWORD" ] || { echo "找不到签名证书：$CERT_DIR" >&2; exit 1; }
DEVICE=${MINICHAT_DEVICE:-00008150-001223841A40C01C}
WORK=$(mktemp -d)
KC=$WORK/minichat.keychain-db
trap 'security delete-keychain "$KC" 2>/dev/null; rm -rf "$WORK"' EXIT

xcodegen generate >/dev/null
xcodebuild -project MiniChat.xcodeproj -scheme MiniChat -destination 'generic/platform=iOS' -configuration Release \
  -derivedDataPath build build CODE_SIGNING_ALLOWED=NO -quiet CURRENT_PROJECT_VERSION="$(date +%Y%m%d%H%M)"
APP=build/Build/Products/Release-iphoneos/MiniChat.app

# 旧版 p12 用 RC2 加密，macOS security 无法导入，先用 openssl 转码。
openssl pkcs12 -in "$MINICHAT_P12" -passin "pass:$MINICHAT_P12_PASSWORD" -legacy -nodes -out "$WORK/all.pem"
openssl pkcs12 -export -in "$WORK/all.pem" -out "$WORK/conv.p12" -passout pass:minichat \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
security create-keychain -p minichat "$KC"
security unlock-keychain -p minichat "$KC"
security import "$WORK/conv.p12" -k "$KC" -P minichat -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k minichat "$KC" >/dev/null
IDENTITY=$(security find-identity -v -p codesigning "$KC" | awk 'NR==1{print $2}')

# 用描述文件的权限签名，保留自己的 Bundle ID（com.xtvv.minichat），不会覆盖同证书的其他 App。
security cms -D -i "$MINICHAT_PROFILE" > "$WORK/profile.plist"
/usr/libexec/PlistBuddy -x -c "Print :Entitlements" "$WORK/profile.plist" > "$WORK/ent.plist"
cp "$MINICHAT_PROFILE" "$APP/embedded.mobileprovision"
codesign --force --sign "$IDENTITY" --keychain "$KC" --entitlements "$WORK/ent.plist" --timestamp=none "$APP"

if [ "$MODE" = "--ota" ]; then
  sh "$OTA_PUBLISH" "$PWD/$APP" "${OTA_NOTE:-}"
  exit 0
fi
xcrun devicectl device install app --device "$DEVICE" "$APP" >/dev/null
xcrun devicectl device process launch --device "$DEVICE" "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")" >/dev/null
echo "已安装并启动"
