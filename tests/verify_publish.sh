#!/usr/bin/env bash
# publish.sh の公開判定を、ローカルのベアリポジトリだけで検証する。
# GitHub にも通信にも触らない。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="${TMPDIR:-/tmp}/rtc-publish-test-$$"
PASS=0; FAIL=0

check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  OK   $1";
  else FAIL=$((FAIL+1)); echo "  FAIL $1  → 期待 $3 / 実際 $2"; fi
}

mkdir -p "$W"
export GIT_TEMPLATE_DIR="$W/tpl"; mkdir -p "$GIT_TEMPLATE_DIR"

# 遠隔リポジトリの代わりになるベアリポジトリ
git init -q --bare "$W/remote.git"

# 作業リポジトリを本番と同じ形で用意する
WORK="$W/work"
mkdir -p "$WORK/scripts" "$WORK/docs"
cp "$ROOT/scripts/publish.sh" "$WORK/scripts/"
cd "$WORK"
git init -q -b main
git config user.email t@example.com
git config user.name test

echo "== 1. git リポジトリでないときは何もせず成功する =="
NOGIT="$W/nogit"; mkdir -p "$NOGIT/scripts" "$NOGIT/docs"
cp "$ROOT/scripts/publish.sh" "$NOGIT/scripts/"
echo "<h1>a</h1>" > "$NOGIT/docs/index.html"
( cd "$NOGIT" && bash scripts/publish.sh > "$W/out1.txt" 2>&1 )
check "終了コード0" "$?" "0"
check "スキップと言う" "$(grep -c 'スキップ' "$W/out1.txt")" "1"

echo "== 2. origin 未設定なら何もせず成功する =="
echo "<h1>a</h1>" > docs/index.html
bash scripts/publish.sh > "$W/out2.txt" 2>&1
check "終了コード0" "$?" "0"
check "originが未設定と言う" "$(grep -c 'origin' "$W/out2.txt")" "1"

echo "== 3. docs/index.html が無ければ失敗する =="
git remote add origin "$W/remote.git"
mv docs/index.html "$W/saved.html"
bash scripts/publish.sh > "$W/out3.txt" 2>&1
check "終了コード1" "$?" "1"
mv "$W/saved.html" docs/index.html

echo "== 4. 正常に公開できる =="
bash scripts/publish.sh > "$W/out4.txt" 2>&1
check "終了コード0" "$?" "0"
check "公開したと言う" "$(grep -c '公開しました' "$W/out4.txt")" "1"
check "リモートに届いている" \
  "$(git --git-dir="$W/remote.git" show HEAD:docs/index.html 2>/dev/null)" "<h1>a</h1>"

echo "== 5. 内容が同じなら何もしない =="
bash scripts/publish.sh > "$W/out5.txt" 2>&1
check "終了コード0" "$?" "0"
check "変化なしと言う" "$(grep -c '変化がない' "$W/out5.txt")" "1"
check "コミットは増えていない" "$(git rev-list --count HEAD)" "1"

echo "== 6. 内容が変われば公開する =="
echo "<h1>b</h1>" > docs/index.html
bash scripts/publish.sh > "$W/out6.txt" 2>&1
check "終了コード0" "$?" "0"
check "コミットが増える" "$(git rev-list --count HEAD)" "2"
check "リモートも更新される" \
  "$(git --git-dir="$W/remote.git" show HEAD:docs/index.html 2>/dev/null)" "<h1>b</h1>"

echo "== 7. ログが書けなくても git は失敗しない =="
# ログ出力とコマンド実行を分離していないと、ここで git ごと失敗して
# 「変化なし」と誤判定し、成功を装ってしまう。
# 存在しないディレクトリ配下を指定して、ログの追記を必ず失敗させる。
echo "<h1>c</h1>" > docs/index.html
bash scripts/publish.sh "$W/no/such/dir/collect.log" > "$W/out7.txt" 2>&1
check "終了コードは0" "$?" "0"
check "コミットは行われる" "$(git rev-list --count HEAD)" "3"
check "リモートにも届いている" \
  "$(git --git-dir="$W/remote.git" show HEAD:docs/index.html 2>/dev/null)" "<h1>c</h1>"

echo "== 8. pushが失敗したら成功を装わない =="
# 認証切れなどで push が失敗したときに「公開しました」と言ってはいけない。
# 自動実行が前提のツールなので、誤った成功報告は誰にも気づかれない。
# 存在しないパスを origin にして、通信なしで push を確実に失敗させる。
echo "<h1>d</h1>" > docs/index.html
git remote set-url origin "$W/does-not-exist.git"
bash scripts/publish.sh > "$W/out8.txt" 2>&1
check "終了コード1" "$?" "1"
check "pushに失敗したと言う" "$(grep -c 'pushに失敗' "$W/out8.txt")" "1"
check "公開したとは言わない" "$(grep -c '公開しました' "$W/out8.txt")" "0"
git remote set-url origin "$W/remote.git"

echo "== 9. コミットが失敗したら成功を装わない =="
# launchd から実行されると user.name が未設定でコミットが失敗しうる。
# ここでは pre-commit フックで確実に失敗させる（環境設定に依存しないため）。
echo "<h1>e</h1>" > docs/index.html
mkdir -p .git/hooks
printf '#!/bin/sh\nexit 1\n' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
BEFORE="$(git rev-list --count HEAD)"
bash scripts/publish.sh > "$W/out9.txt" 2>&1
check "終了コード1" "$?" "1"
check "コミットに失敗したと言う" "$(grep -c 'コミットに失敗' "$W/out9.txt")" "1"
check "公開したとは言わない" "$(grep -c '公開しました' "$W/out9.txt")" "0"
check "コミットは増えていない" "$(git rev-list --count HEAD)" "$BEFORE"
rm -f .git/hooks/pre-commit

echo "== 10. git add が失敗したら成功を装わない =="
# index.lock が残っていると git add は失敗する。ここでも成功を装わないこと。
echo "<h1>f</h1>" > docs/index.html
: > .git/index.lock
bash scripts/publish.sh > "$W/out10.txt" 2>&1
check "終了コード1" "$?" "1"
check "git add に失敗したと言う" "$(grep -c 'git add に失敗' "$W/out10.txt")" "1"
check "公開したとは言わない" "$(grep -c '公開しました' "$W/out10.txt")" "0"
rm -f .git/index.lock

echo "== 11. index に危険なファイルが残っていたら公開しない =="
# setup_github.sh が中止したあとや、手作業の git add -A のあとを想定する。
echo "<h1>g</h1>" > docs/index.html
mkdir -p .browser-profile/Default
echo "SESSION_COOKIE" > .browser-profile/Default/Cookies
git add -f .browser-profile/Default/Cookies
BEFORE="$(git rev-list --count HEAD)"
bash scripts/publish.sh > "$W/out11.txt" 2>&1
check "終了コード1" "$?" "1"
check "中止したと言う" "$(grep -c '公開してはいけないファイル' "$W/out11.txt")" "1"
check "公開したとは言わない" "$(grep -c '公開しました' "$W/out11.txt")" "0"
check "コミットは増えていない" "$(git rev-list --count HEAD)" "$BEFORE"
git reset -q
rm -rf .browser-profile

echo "== 12. docs/index.html 以外の変更を巻き込まない =="
# index に無関係なファイルが載っていても、公開するのは docs/index.html だけ。
echo "<h1>h</h1>" > docs/index.html
echo "無関係" > unrelated.txt
git add unrelated.txt
bash scripts/publish.sh > "$W/out12.txt" 2>&1
check "終了コード0" "$?" "0"
check "公開した" "$(grep -c '公開しました' "$W/out12.txt")" "1"
check "無関係なファイルはリモートに存在しない" \
  "$(git --git-dir="$W/remote.git" show HEAD:unrelated.txt >/dev/null 2>&1; echo $?)" "128"
check "無関係なファイルは index に残ったまま" \
  "$(git diff --cached --name-only | grep -c unrelated.txt)" "1"
git reset -q
rm -f unrelated.txt

cd /
rm -rf "$W"
echo
echo "結果: $PASS pass / $FAIL fail"
[ "$FAIL" -eq 0 ]
