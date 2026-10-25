'use strict';
// 极简 JSON Schema 校验器（零依赖）。
// 只实现本项目契约用到的关键字子集，避免为了校验再引入第三方依赖。
// 支持：type / required / additionalProperties / properties / items / enum / const /
//       pattern / minLength / maxLength / minimum / maximum / uniqueItems / minItems
// 未支持的关键字被忽略（$id、title、description、format、default、const 以外的注解）。

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(expected, value) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

/**
 * @returns {{valid: boolean, errors: Array<{path: string, message: string}>}}
 */
function validate(schema, value, options = {}) {
  const errors = [];
  const maxErrors = Number.isSafeInteger(options.maxErrors) ? options.maxErrors : 50;

  function fail(p, message) {
    if (errors.length < maxErrors) errors.push({ path: p, message });
  }

  function walk(node, current, p) {
    if (node === null || typeof node !== 'object') return;
    if (errors.length >= maxErrors) return;

    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.some((t) => matchesType(t, current))) {
        fail(p, `类型应为 ${types.join('|')}，实际 ${typeOf(current)}`);
        return; // 类型不符时后续关键字无意义
      }
    }

    if (node.const !== undefined && current !== node.const) fail(p, `必须等于 ${JSON.stringify(node.const)}`);

    if (Array.isArray(node.enum) && !node.enum.some((v) => v === current)) {
      fail(p, `取值必须是 ${node.enum.map((v) => JSON.stringify(v)).join(' | ')} 之一`);
    }

    if (typeof current === 'string') {
      if (Number.isSafeInteger(node.minLength) && current.length < node.minLength) fail(p, `长度不得小于 ${node.minLength}`);
      if (Number.isSafeInteger(node.maxLength) && current.length > node.maxLength) fail(p, `长度不得大于 ${node.maxLength}`);
      if (typeof node.pattern === 'string') {
        let re = null;
        try {
          re = new RegExp(node.pattern);
        } catch {
          fail(p, 'schema.pattern 不是合法正则');
        }
        if (re && !re.test(current)) fail(p, `不匹配模式 ${node.pattern}`);
      }
    }

    if (typeof current === 'number') {
      if (typeof node.minimum === 'number' && current < node.minimum) fail(p, `不得小于 ${node.minimum}`);
      if (typeof node.maximum === 'number' && current > node.maximum) fail(p, `不得大于 ${node.maximum}`);
    }

    if (Array.isArray(current)) {
      if (Number.isSafeInteger(node.minItems) && current.length < node.minItems) fail(p, `元素个数不得少于 ${node.minItems}`);
      if (node.uniqueItems === true) {
        const seen = new Set();
        current.forEach((item, index) => {
          const key = JSON.stringify(item);
          if (seen.has(key)) fail(`${p}[${index}]`, '数组元素不得重复');
          seen.add(key);
        });
      }
      if (node.items !== undefined) current.forEach((item, index) => walk(node.items, item, `${p}[${index}]`));
    }

    if (typeOf(current) === 'object') {
      const properties = node.properties || {};
      for (const key of node.required || []) {
        if (!(key in current)) fail(p, `缺少必填字段 ${key}`);
      }
      for (const [key, sub] of Object.entries(properties)) {
        if (key in current) walk(sub, current[key], `${p}.${key}`);
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(current)) {
          if (!(key in properties)) fail(`${p}.${key}`, '不允许的额外字段');
        }
      } else if (node.additionalProperties !== undefined && typeof node.additionalProperties === 'object') {
        for (const key of Object.keys(current)) {
          if (!(key in properties)) walk(node.additionalProperties, current[key], `${p}.${key}`);
        }
      }
    }
  }

  walk(schema, value, '$');
  return { valid: errors.length === 0, errors };
}

module.exports = { validate, typeOf };
