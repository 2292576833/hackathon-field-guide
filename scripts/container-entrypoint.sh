#!/bin/sh
# 容器入口：为魔搭社区创空间（Docker 类型）提供数据持久化，然后把控制权交给真正的命令。
#
# 背景
#   创空间只有一个持久化目录 /mnt/workspace，容器重启后其它路径全部重置。
#   本站把 PGlite 数据目录固定在 <cwd>/.runtime/postgres-data（src/server/config.ts），
#   这里只把这一项接到持久目录上；镜像内的 DSH 运行时留在 /app/.runtime/dsh-runtime 不动，
#   因此 DSH_RUNTIME_PACKAGE_DIRECTORY 与 Compose 保持一致，无需改动。
#
# 为什么本地密钥不在这里持久化
#   src/server/config.ts 在缺少 AUTH_CODE_PEPPER 时，会以 "wx"（O_CREAT|O_EXCL）写
#   .runtime/local-secrets.json，目的正是防止两个进程各自生成不同的 pepper。
#   所以这里**不能**预建该文件（空文件会让 JSON.parse 抛错），也**不能**用悬空符号链接
#   （符号链接自身已存在，open(O_EXCL) 返回 EEXIST，随后的重读又因 ENOENT 失败）。
#   正确做法是部署时显式提供 AUTH_CODE_PEPPER，该文件就不会被创建。
#
# 对既有 Compose 部署无影响
#   Compose 的容器是只读根文件系统，且不存在 /mnt/workspace；
#   本脚本检测到该目录不存在即直接放行，既不改动文件也不打印告警，行为与从前一致。
set -eu

persistent=/mnt/workspace

# 平台持久化目录不存在 => Compose / 普通 docker run，不需要也不应该做任何改动。
if [ ! -d "$persistent" ]; then
  exec "$@"
fi

if ! mkdir -p "$persistent/state/postgres-data" 2>/dev/null || [ ! -w "$persistent/state/postgres-data" ]; then
  echo "[container] 警告：$persistent 存在但不可写，本次运行的账号、项目与审核数据在重启后会全部丢失。" >&2
  exec "$@"
fi

runtime=/app/.runtime
mkdir -p "$runtime"

if [ ! -e "$runtime/postgres-data" ]; then
  # 先建好目标目录再建链接，避免出现悬空符号链接。
  ln -s "$persistent/state/postgres-data" "$runtime/postgres-data"
  echo "[container] PGlite 数据目录已指向 $persistent/state/postgres-data"
fi

if [ -z "${AUTH_CODE_PEPPER:-}" ]; then
  echo "[container] 警告：未提供 AUTH_CODE_PEPPER，pepper 将只写在容器内并随重启失效，既有会话与加密凭据将无法解密。" >&2
fi

exec "$@"
