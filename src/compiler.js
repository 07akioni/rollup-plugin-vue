import deIndent from 'de-indent'
import validateTemplate from 'vue-template-validator'
import {relative} from 'path'
import parse5 from 'parse5'
import htmlMinifier from 'html-minifier'
import chalk from 'chalk'
import compilers from './compilers/index'
import postcss from 'postcss'

require('es6-promise').polyfill()

/**
 * Ensure there's only one template node.
 *
 * @param {DocumentFragment} fragment
 * @return {Boolean}
 */
function validateNodeCount (fragment) {
  var count = 0
  fragment.childNodes.forEach(function (node) {
    if (node.nodeName === 'template') {
      count++
    }
  })
  return count <= 1
}

/**
 * Parse string into an HTML tree
 *
 * @param {string} content
 * @returns {DocumentFragment}
 */
function parseContent (content) {
  // noinspection JSValidateTypes
  return parse5.parseFragment(content, {locationInfo: true})
}

/**
 * Check the lang attribute of a parse5 node.
 *
 * @param {Node} node
 * @return {String|undefined}
 */
function checkLang (node) {
  if (node.attrs) {
    var i = node.attrs.length
    while (i--) {
      var attr = node.attrs[i]
      if (attr.name === 'lang') {
        return attr.value
      }
    }
  }
}

/**
 * Pad content with empty lines to get correct line number in errors.
 *
 * @param content
 * @returns {string}
 */
function padContent (content) {
  return content
      .split(/\r?\n/g)
      .map(function () { return '' })
      .join('\n')
}

export default class Compiler {
  constructor (options = {}) {
    this.options = options
  }
  compile (content, filePath) {
    // 1. Parse the file into an HTML tree
    const fragment = parseContent(content)

    // 2. Check number of nodes.
    if (!validateNodeCount(fragment)) {
      throw new Error('Only one script tag and one template tag allowed per *.vue file.')
    }

    // 3. Walk through the top level nodes and check for their
    //    types & languages. If there are pre-processing needed,
    //    then push it into a jobs list.
    /**
     * @type {{script: Node, template: Node, style: Node}}
     */
    const components = {}
    for (let node of fragment.childNodes) {
      components[node.nodeName] = node
    }
    const promise = new Promise((resolve) => {resolve()})
    return promise
        .then(() => {
          return this.processTemplate(components.template, filePath, content)
        })
        .then((template) => {
          if (components.style) {
            return this.processStyle(components.style, filePath, content)
                .then((style) => {
                  return {template: template.code, style: style.code}
                })
          }
          return {template: template.code, style: ''}
        })
        .then((compiled) => {
          return this.processScript(components.script, filePath, content, compiled)
        })
  }

  /**
   * Check src import for a node, relative to the filePath if
   * available. Using readFileSync for now since this is a
   * rare use case.
   *
   * @param {Node} node
   * @param {String} filePath
   * @return {String}
   */
  checkSrc (node, filePath) {
    // TODO: Up next. ${node}, ${filePath}
    return null
  }

  /**
   * Compile template: DeIndent and minify html.
   * @param {Node} node
   * @param {string} filePath
   * @param {string} content
   */
  processTemplate (node, filePath, content) {
    let template = deIndent(this.checkSrc(node, filePath) || parse5.serialize(node.content))
    const lang = checkLang(node)
    if (!lang) {
      const warnings = validateTemplate(node.content, content)
      if (warnings) {
        const relativePath = relative(process.cwd(), filePath)
        warnings.forEach(function (msg) {
          console.warn(chalk.red(`\n Error in ${relativePath}:\n ${msg}`))
        })
      }
    }
    return this.compileAsPromise('template', template, lang, filePath)
        .then((res) => {
          res.code = htmlMinifier.minify(res.code, this.options.htmlMinifier)
          return res
        })
  }
  /**
   * @param {Node} node
   * @param {string} filePath
   * @param {string} content
   * @param {*} compiled
   */
  processScript (node, filePath, content, compiled) {
    const lang = checkLang(node) || 'buble'
    let script = this.checkSrc(node, filePath)
    let {template} = compiled
    if (!script) {
      script = parse5.serialize(node)
      // pad the script to ensure correct line number for syntax errors
      const location = content.indexOf(script)
      const before = padContent(content.slice(0, location))
      script = before + script
    }
    script = this.injectTemplate(script, template, lang)
    script = deIndent(script)
    return this.compileAsPromise('script', script, lang, filePath)
        .then((res) => {
          return {code: res.code}
        })
  }
  /**
   * @param {Node} node
   * @param {string} filePath
   * @param {string} content
   */
  processStyle (node, filePath, content) {
    const lang = checkLang(node) || 'css'
    let style = this.checkSrc(node, filePath)
    const injectFnName = '__$styleInject'
    if (!style) {
      style = parse5.serialize(node)
      const location = content.indexOf(style)
      const before = padContent(content.slice(0, location))
      style = before + style
    }
    let options = this.options.postcss
    options.from = filePath
    options.to = filePath
    return this.compileAsPromise('style', style, lang, filePath)
        .then((res) => {
          return postcss(this.options.postcss.plugins || [])
              .process(res.code, options)
              .then((res) => {
                const code = `export ${injectFnName}(${JSON.stringify(res.css)});`
                return {code: code, type: 'style'}
              })
        })
  }

  compileAsPromise (type, code, lang, filePath) {
    var compiler = compilers[lang]
    if (compiler) {
      return new Promise((resolve, reject) => {
        try {
          let compiled = compiler.compile(code, this, filePath)
          resolve(compiled)
        } catch (e) {
          reject(e)
        }
      })
    }
    return Promise.resolve({code: code, type: type})
  }

  injectTemplate (script, template, lang) {
    const compiler = compilers[lang]
    if (compiler) {
      return compiler.inject(script, template)
    }
    throw new Error(`rollup-plugin-vue cannot inject template in ${lang} script.`)
  }
}
