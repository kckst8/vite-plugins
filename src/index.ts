import * as path from 'path'
import { Plugin } from 'vite'
import { files } from 'node-dir'

type PluginOptions = {
    /**
     * The base path of your project used in require.context. Default to be `process.cwd()`
     */
    projectBasePath?: string,

    /**
     * The default RegExp used in `require.context` if the third parameter of `require.context` is not specified. Default to be `/\.(json|js)$/`
     */
    defaultRegExp?: RegExp
}

const DEFAULT_PROJECT_BASE_PATH: string = process.cwd()
const DEFAULT_USE_RECURSIVE: boolean = false
const DEFAULT_REGEXP: RegExp = /^\.\/.*$/
const REQUIRE_CONTEXT_STRING_PREFIX: string = '__require_context_for_vite'
const PLUGIN_NAME: string = '@originjs/vite-plugin-require-context'
const GENERATED_CODE_COMMENT: string = `// generated by ${PLUGIN_NAME}\n`

export default (options: PluginOptions = {}): Plugin => {
    return {
        name: 'vite:require-context',
        apply: 'serve',
        async transform(code: string, id: string) {
            const requireContextRegex: RegExp = /require\.context\((.+)\)/g
            const nodeModulesPath: string = '/node_modules/'

            if (id.includes(nodeModulesPath)) {
                return null
            }

            const requireContextMatches = [...code.matchAll(requireContextRegex)]
            if (requireContextMatches.length === 0) {
                return null
            }

            let transformedCode: string = code
            let addedCode: string = ''

            requireContextMatches.forEach((requireContextMatch, index) => {
                const params: string[] = requireContextMatch[1].split(',')
                const directory: string = params[0] || ''
                const recursive: boolean = (!params[1]) ? DEFAULT_USE_RECURSIVE : eval(params[1])
                const regExp: RegExp = (!params[2]) ? DEFAULT_REGEXP : eval(params[2])



                const { importsString, key2FilesMapString, contextFunctionString, requireContextFunctionName} = transformRequireContext(
                    eval(directory),
                    recursive,
                    regExp,
                    id,
                    options.projectBasePath,
                    index
                )

                const generatedRequireContextStart = `\n// start of generated code of ${requireContextFunctionName}, generated by ${PLUGIN_NAME}\n`
                const generatedRequireContextEnd = `// end of generated code of ${requireContextFunctionName}\n`
                addedCode += generatedRequireContextStart + importsString + key2FilesMapString + contextFunctionString + generatedRequireContextEnd
                transformedCode = transformedCode.replace(
                    requireContextMatch[0],
                    requireContextFunctionName
                )
            })

            transformedCode = GENERATED_CODE_COMMENT + addedCode + transformedCode
            return { code: transformedCode }
        },
    }
}

function transformRequireContext(
    directory: string,
    recursive: boolean = DEFAULT_USE_RECURSIVE,
    regExp: RegExp = DEFAULT_REGEXP,
    workingFilePath: string,
    projectBasePath: string = DEFAULT_PROJECT_BASE_PATH,
    matchIndex: number
) {
    let basePath: string

    switch (directory[0]) {
        case '.' :
            basePath = path.join(workingFilePath, '..\\', directory)
            break
        case '/' :
            basePath = path.join(projectBasePath, directory)
            break
        case '@' :
            basePath = path.join(projectBasePath, 'src', directory.substr(1))
            break
        default:
            basePath = path.join(projectBasePath, 'node_modules', directory)
    }

    const absolutePaths: string[] = files(basePath, {
            sync: true,
            recursive: recursive,
        })
        .filter(function (file) {
            return file.match(regExp)
        })
        .map(function (absolutePath) {
            return absolutePath.replace(/\\/g, '/')
        })

    const importedFiles: string[] = absolutePaths.map((absolutePath) => {
        return absolutePath.slice(projectBasePath.length)
    })

    const keys: string[] = absolutePaths.map((absolutePath) => {
        return './' + absolutePath.slice(basePath.length + 1)
    })

    const requireContextMapName = `${REQUIRE_CONTEXT_STRING_PREFIX}_map_${matchIndex}`
    const requireContextFunctionName = `${REQUIRE_CONTEXT_STRING_PREFIX}_function_${matchIndex}`

    const key2FilesMap = generateKey2FilesMap(keys, importedFiles, matchIndex)
    const importsString = generateImportsString(keys, importedFiles, matchIndex)
    const key2FilesMapString = generateKey2FilesMapString(key2FilesMap, requireContextMapName)
    const contextFunctionString = generateContextFunctionString(requireContextFunctionName, requireContextMapName)

    return {
        importsString,
        key2FilesMapString,
        contextFunctionString,
        requireContextFunctionName
    }
}

function generateKey2FilesMap(
    keys: string[],
    importedFiles: string[],
    matchIndex: number
): object {
    let key2FilesMap: object = {}
    keys.forEach((key, index) => {
        const importEntry:string = `${REQUIRE_CONTEXT_STRING_PREFIX}_${matchIndex}_${index}`
        key2FilesMap[key] = {
            'importEntry': importEntry,
            'filePath': './' + importedFiles[index]
        }
    })

    return key2FilesMap
}

function generateImportsString(
    keys: string[],
    importedFiles: string[],
    matchIndex: number
): string {
    let importsString: string = ''
    for (let index = 0; index < keys.length; index++) {
        const importEntry:string = `${REQUIRE_CONTEXT_STRING_PREFIX}_${matchIndex}_${index}`
        importsString += `import * as ${importEntry} from "${importedFiles[index]}";\n`
    }
    importsString += '\n'

    return importsString
}

function generateKey2FilesMapString (
    key2FilesMap: object,
    requireContextMapName: string
): string {
    let key2FilesMapString = `var ${requireContextMapName} = {\n`
    Object.keys(key2FilesMap).forEach((key) => {
        key2FilesMapString += `\t"${key}" : ${key2FilesMap[key].importEntry},\n`
    })
    key2FilesMapString = key2FilesMapString.substring(0, key2FilesMapString.length - 2) + '\n};\n'

    return key2FilesMapString
}

function generateContextFunctionString(
    requireContextFunctionName: string,
    requireContextMapName: string
): string {
    const requireContextResolveFunctionName = `${requireContextFunctionName}_resolve`
    const requireContextKeysFunctionName = `${requireContextFunctionName}_keys`
    // webpackContext(req)
    let contextFunctionString = `function ${requireContextFunctionName}(req) {
    var id = ${requireContextResolveFunctionName}(req);
    return ${requireContextMapName}[req];
}\n`

    // webpackContextResolve(req)
    contextFunctionString += `function ${requireContextResolveFunctionName}(req) {
    if (req in ${requireContextMapName}) {
        return ${requireContextMapName}[req];
    }
    var e = new Error("Cannot find module '" + req + "'");
    e.code = 'MODULE_NOT_FOUND';
    throw e;
}\n`

    // webpackConext.keys
    contextFunctionString += `${requireContextFunctionName}.keys = function ${requireContextKeysFunctionName}() {
    return Object.keys(${requireContextMapName});
}\n`

    // webpackContext.resolve
    contextFunctionString += `${requireContextFunctionName}.resolve = ${requireContextResolveFunctionName}\n`

    // webpackContext.id
    // TODO: not implemented as webpack did
    contextFunctionString += `${requireContextFunctionName}.id = "${REQUIRE_CONTEXT_STRING_PREFIX}_${requireContextFunctionName}"\n`

    return contextFunctionString
}