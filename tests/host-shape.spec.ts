import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

/** 项目根：本 spec 位于 tests/ 下。 */
const ROOT = resolve(import.meta.dirname, '..')

/** 插件入口。 */
const ENTRY = resolve(ROOT, 'host', 'index.ts')

/**
 * 建 host face 的 program，复用 tsconfig.json 的 compilerOptions（含继承来的 paths）。
 * @returns 已绑定源文件的 program。
 */
function hostProgram(): ts.Program {
  const configPath = resolve(ROOT, 'tsconfig.json')
  const read = ts.readConfigFile(configPath, file => ts.sys.readFile(file))
  assert.equal(
    read.error,
    undefined,
    `tsconfig.json: ${read.error === undefined ? '' : ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`,
  )
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT, undefined, configPath)
  assert.deepEqual(
    parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')),
    [],
    'tsconfig.json must parse without config errors',
  )
  return ts.createProgram(parsed.fileNames, parsed.options)
}

const program = hostProgram()
const checker = program.getTypeChecker()
const source = program.getSourceFile(ENTRY)
assert.ok(source !== undefined, 'host/index.ts must be part of the host program')
const moduleSymbol = checker.getSymbolAtLocation(source)
assert.ok(moduleSymbol !== undefined, 'host/index.ts must have a module symbol')
const exports = checker.getExportsOfModule(moduleSymbol)

/** 读取一个具名导出的声明节点。 */
function declarationOf(name: string): ts.Declaration {
  const symbol = exports.find(candidate => candidate.getName() === name)
  assert.ok(symbol !== undefined, `host/index.ts must export ${name}`)
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  assert.ok(declaration !== undefined, `export ${name} must have a declaration`)
  return declaration
}

test('导出面恰好是 name / inject / Config / apply，没有 default', () => {
  assert.deepEqual(exports.map(symbol => symbol.getName()).sort(), ['Config', 'apply', 'inject', 'name'])
  // Loader 的 unwrapExports 会取 .default，加了它就会把 inject / name / Config 一起丢掉。
  assert.ok(!exports.some(symbol => symbol.getName() === 'default'))
})

test('name 是全小写连字符的 Loader 名，不是包名', () => {
  const symbol = exports.find(candidate => candidate.getName() === 'name')
  assert.ok(symbol !== undefined)
  const declaration = declarationOf('name')
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  assert.ok(type.isStringLiteral(), 'name must be declared as a const with a literal type')
  assert.equal(type.value, 'execution-engine')
})

test('inject 只声明阶段 0 真正用得到的服务', () => {
  const declaration = declarationOf('inject')
  assert.ok(ts.isVariableDeclaration(declaration), 'inject must be a const declaration')
  const initializer = declaration.initializer
  assert.ok(initializer !== undefined && ts.isArrayLiteralExpression(initializer), 'inject must be an array literal')
  assert.deepEqual(
    initializer.elements.map(element => (ts.isStringLiteral(element) ? element.text : element.getText())),
    ['tools'],
  )
})

test('host face 的 program 在本目录内没有编译错误', () => {
  const prefix = ROOT.toLowerCase()
  const local = ts.getPreEmitDiagnostics(program).filter((diagnostic) => {
    if (diagnostic.file === undefined) return false
    return resolve(diagnostic.file.fileName).toLowerCase().startsWith(prefix)
  })
  assert.deepEqual(
    local.map(diagnostic =>
      `${diagnostic.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`),
    [],
  )
})
