import { createBackup, restoreBackup } from './backup.ts'

const [command, source, target] = process.argv.slice(2)
if (!source || !target || !['create', 'restore'].includes(command ?? '')) {
  process.stderr.write('用法：node src/backup-cli.ts create <数据目录> <新备份目录>\n或：node src/backup-cli.ts restore <备份目录> <新数据目录>\n')
  process.exitCode = 2
} else {
  try {
    const result = command === 'create' ? await createBackup(source, target) : await restoreBackup(source, target)
    process.stdout.write(`${command === 'create' ? '备份完成' : '恢复完成'}：${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${command === 'create' ? '备份失败' : '恢复失败'}：${error instanceof Error ? error.message : '未知错误'}\n`)
    process.exitCode = 1
  }
}
