/*!
 * CodexMarkdown - local markdown renderer for codex-web.
 * Contract: CONTRACT.md section 5. Zero dependencies, no eval, no network.
 * Usage: window.CodexMarkdown.render(text, { streaming: true })
 */
(function (root) {
  'use strict';

  var MAX_INPUT = 512 * 1024;
  var BT = String.fromCharCode(96);

  /* ---------------------------------------------------------------- escape */

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, function (ch) {
      if (ch === '&') return '&amp;';
      if (ch === '<') return '&lt;';
      if (ch === '>') return '&gt;';
      if (ch === '"') return '&quot;';
      return '&#39;';
    });
  }

  function safeUrl(raw) {
    var url = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!url) return null;
    if (/[\u0000-\u001f\u007f]/.test(url)) return null;
    var scheme = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(url);
    if (scheme) {
      var s = scheme[1].toLowerCase();
      if (s !== 'http' && s !== 'https' && s !== 'mailto' && s !== 'ftp' && s !== 'tel') return null;
    }
    return url;
  }

  function attr(value) {
    return escapeHtml(value);
  }

  /* ---------------------------------------------------------------- base64 */

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') {
      try {
        return new TextEncoder().encode(str);
      } catch (e) { /* fall through */ }
    }
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          i++;
        } else {
          out.push(0xef, 0xbf, 0xbd);
        }
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  var B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function base64FromBytes(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var b = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += B64C.charAt((b >> 18) & 63);
      out += B64C.charAt((b >> 12) & 63);
      out += (i + 1 < bytes.length) ? B64C.charAt((b >> 6) & 63) : '=';
      out += (i + 2 < bytes.length) ? B64C.charAt(b & 63) : '=';
    }
    return out;
  }

  function toBase64(str) {
    var bytes = utf8Bytes(str);
    if (typeof btoa === 'function') {
      try {
        var bin = '';
        var CH = 0x2000;
        for (var i = 0; i < bytes.length; i += CH) {
          var slice = bytes.subarray ? bytes.subarray(i, i + CH) : bytes.slice(i, i + CH);
          bin += String.fromCharCode.apply(null, slice);
        }
        return btoa(bin);
      } catch (e) { /* fall through to manual encoder */ }
    }
    return base64FromBytes(bytes);
  }

  /* ----------------------------------------------------------- highlighting */

  function makeSet(words) {
    var set = Object.create(null);
    var parts = String(words).split(' ');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) set[parts[i]] = true;
    }
    return set;
  }

  var KW_BASH = makeSet('if then else elif fi for while until do done case esac in function return local export readonly declare unset shift source alias echo printf cd pwd exit set trap wait read eval exec test sudo apt npm npx node python pip git curl wget grep sed awk cat ls mkdir rmdir rm cp mv touch chmod chown ps kill killall nohup true false');
  var KW_JS = makeSet('const let var function return if else for while do switch case break continue new class extends super this typeof instanceof in of null undefined true false async await yield try catch finally throw delete void static get set import from export default interface type enum implements public private protected readonly namespace declare as satisfies keyof infer never unknown any string number boolean symbol bigint console window document');
  var KW_PY = makeSet('def class return if elif else for while in not and or is None True False import from as with try except finally raise pass lambda yield global nonlocal assert del async await print self match case break continue');
  var KW_JSON = makeSet('true false null');

  var HL = {
    bash: { line: '#', block: null, quotes: '\'"', triple: false, kw: KW_BASH },
    js: { line: '//', block: ['/*', '*/'], quotes: '\'"', triple: false, kw: KW_JS },
    ts: { line: '//', block: ['/*', '*/'], quotes: '\'"', triple: false, kw: KW_JS },
    python: { line: '#', block: null, quotes: '\'"', triple: true, kw: KW_PY },
    json: { line: null, block: null, quotes: '"', triple: false, kw: KW_JSON }
  };

  var LANG_ALIASES = {
    bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
    shellscript: 'bash', terminal: 'bash', 'shell-session': 'bash',
    js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
    ts: 'ts', typescript: 'ts', tsx: 'ts',
    py: 'python', python: 'python', python3: 'python',
    json: 'json', jsonc: 'json'
  };

  var NUM_RE = /(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  var WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;

  function isWordChar(ch) {
    return !!ch && /[A-Za-z0-9_$]/.test(ch);
  }

  function isWordStart(ch) {
    return !!ch && /[A-Za-z_$]/.test(ch);
  }

  function highlight(code, lang) {
    var key = LANG_ALIASES[String(lang || '').toLowerCase()];
    var cfg = key ? HL[key] : null;
    if (!cfg || code.length > 200000) return escapeHtml(code);

    var out = '';
    var plain = '';
    var i = 0;
    var n = code.length;

    function flush() {
      if (plain) {
        out += escapeHtml(plain);
        plain = '';
      }
    }
    function token(cls, text) {
      flush();
      out += '<span class="tok-' + cls + '">' + escapeHtml(text) + '</span>';
    }

    while (i < n) {
      var ch = code.charAt(i);

      if (cfg.line && code.startsWith(cfg.line, i) && (cfg.line !== '#' || i === 0 || /\s/.test(code.charAt(i - 1)))) {
        var eol = code.indexOf('\n', i);
        if (eol < 0) eol = n;
        token('com', code.slice(i, eol));
        i = eol;
        continue;
      }

      if (cfg.block && code.startsWith(cfg.block[0], i)) {
        var endBlock = code.indexOf(cfg.block[1], i + cfg.block[0].length);
        endBlock = endBlock < 0 ? n : endBlock + cfg.block[1].length;
        token('com', code.slice(i, endBlock));
        i = endBlock;
        continue;
      }

      if (cfg.quotes.indexOf(ch) >= 0) {
        if (cfg.triple) {
          var trip = code.substr(i, 3);
          if (trip === '"""' || trip === "'''") {
            var endTrip = code.indexOf(trip, i + 3);
            endTrip = endTrip < 0 ? n : endTrip + 3;
            token('str', code.slice(i, endTrip));
            i = endTrip;
            continue;
          }
        }
        var j = i + 1;
        var allowNl = (ch === BT);
        while (j < n) {
          var d = code.charAt(j);
          if (d === '\\') { j += 2; continue; }
          if (d === ch) { j++; break; }
          if (d === '\n' && !allowNl) break;
          j++;
        }
        if (j > n) j = n;
        token('str', code.slice(i, j));
        i = j;
        continue;
      }

      if (ch >= '0' && ch <= '9' && (i === 0 || !isWordChar(code.charAt(i - 1)))) {
        NUM_RE.lastIndex = i;
        var num = NUM_RE.exec(code);
        if (num) {
          token('num', num[0]);
          i += num[0].length;
          continue;
        }
      }

      if (isWordStart(ch)) {
        WORD_RE.lastIndex = i;
        var word = WORD_RE.exec(code);
        if (word) {
          if (cfg.kw[word[0]]) token('kw', word[0]);
          else plain += word[0];
          i += word[0].length;
          continue;
        }
      }

      plain += ch;
      i++;
    }

    flush();
    return out;
  }

  /* --------------------------------------------------------------- inline */

  var STICKY_URL = /(?:https?:\/\/|www\.)[^\s<>"]+/y;

  function repeatChar(code, count) {
    var s = '';
    for (var i = 0; i < count; i++) s += String.fromCharCode(code);
    return s;
  }

  function indexOfBounded(src, needle, from, limit) {
    var end = Math.min(src.length, from + limit);
    var found = src.slice(from, end).indexOf(needle);
    return found < 0 ? -1 : from + found;
  }

  function matchParen(src, start, limit) {
    var depth = 1;
    var end = Math.min(src.length, start + (limit || 2048));
    for (var i = start; i < end; i++) {
      var c = src.charAt(i);
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return i;
      } else if (c === '\n') return -1;
    }
    return -1;
  }

  function trimUrl(raw) {
    var url = raw;
    var cut = url.indexOf(BT);
    if (cut >= 0) url = url.slice(0, cut);
    for (;;) {
      var last = url.charAt(url.length - 1);
      if (last === '.' || last === ',' || last === ';' || last === ':' || last === '!' || last === '?' ||
          last === '*' || last === '_' || last === '~' || last === '"' || last === "'") {
        url = url.slice(0, -1);
        continue;
      }
      if (last === ')' && countChar(url, '(') < countChar(url, ')')) {
        url = url.slice(0, -1);
        continue;
      }
      break;
    }
    return url;
  }

  function countChar(str, ch) {
    var count = 0;
    for (var i = 0; i < str.length; i++) if (str.charAt(i) === ch) count++;
    return count;
  }

  function inline(src, depth) {
    if (depth > 6) return escapeHtml(src);
    var out = '';
    var plain = '';
    var i = 0;
    var n = src.length;
    var budget = 400000;

    function flush() {
      if (plain) {
        out += escapeHtml(plain);
        plain = '';
      }
    }

    while (i < n) {
      var c = src.charCodeAt(i);

      if (c === 10) {
        flush();
        out += '<br>';
        i++;
        continue;
      }

      if (c === 92 && i + 1 < n) {
        var nx = src.charCodeAt(i + 1);
        if (nx === 92 || nx === 96 || nx === 42 || nx === 95 || nx === 126 || nx === 91 || nx === 93 ||
            nx === 40 || nx === 41 || nx === 35 || nx === 45 || nx === 43 || nx === 46 || nx === 33 ||
            nx === 62 || nx === 124 || nx === 123 || nx === 125 || nx === 36 || nx === 126) {
          plain += src.charAt(i + 1);
          i += 2;
          continue;
        }
      }

      if (c === 96) {
        var run = 0;
        var k = i;
        while (k < n && src.charCodeAt(k) === 96) { run++; k++; }
        var needle = repeatChar(96, run);
        var close = -1;
        if (budget > 0) {
          var windowEnd = Math.min(n, k + 4000);
          var off = src.slice(k, windowEnd).indexOf(needle);
          if (off >= 0) close = k + off;
          budget -= (windowEnd - k);
        }
        if (close >= k) {
          flush();
          out += '<code>' + escapeHtml(src.slice(k, close)) + '</code>';
          i = close + run;
          continue;
        }
        plain += needle;
        i += run;
        continue;
      }

      if (c === 91) {
        var rb = indexOfBounded(src, ']', i + 1, 2000);
        if (rb > i + 1 && src.charCodeAt(rb + 1) === 40) {
          var rp = matchParen(src, rb + 2, 2048);
          if (rp > rb) {
            var target = src.slice(rb + 2, rp);
            // Strip an optional link title: [t](url "title")
            var tmatch = /^\s*(\S+?)\s+(?:"[^"]*"|'[^']*'|\([^()]*\))\s*$/.exec(target);
            if (tmatch) target = tmatch[1];
            var url = safeUrl(target);
            if (url) {
              flush();
              out += '<a href="' + attr(url) + '" target="_blank" rel="noreferrer noopener">' +
                inline(src.slice(i + 1, rb), depth + 1) + '</a>';
              i = rp + 1;
              continue;
            }
          }
        }
        plain += '[';
        i++;
        continue;
      }

      if ((c === 104 || c === 119) && (i === 0 || !isWordChar(src.charAt(i - 1)))) {
        STICKY_URL.lastIndex = i;
        var m = STICKY_URL.exec(src);
        if (m) {
          var text = trimUrl(m[0]);
          if (text.length > 3) {
            var href = text.indexOf('www.') === 0 ? 'http://' + text : text;
            flush();
            out += '<a href="' + attr(href) + '" target="_blank" rel="noreferrer noopener">' +
              escapeHtml(text) + '</a>';
            i += text.length;
            continue;
          }
        }
      }

      if (c === 42 || c === 95 || c === 126) {
        var runLen = 1;
        while (i + runLen < n && src.charCodeAt(i + runLen) === c) runLen++;
        var mark = String.fromCharCode(c);

        if (c === 126 && runLen < 2) {
          plain += mark;
          i++;
          continue;
        }
        if (c === 95 && i > 0 && isWordChar(src.charAt(i - 1))) {
          plain += mark;
          i++;
          continue;
        }

        var want = c === 126 ? 2 : Math.min(runLen, 3);
        var needle2 = repeatChar(c, want);
        var startIdx = i + want;
        var found = -1;
        if (budget > 0 && startIdx < n) {
          var windowEnd2 = Math.min(n, i + 4000);
          var sub = src.slice(startIdx, windowEnd2);
          var off2 = sub.indexOf(needle2);
          while (off2 >= 0) {
            var pos = startIdx + off2;
            var afterLong = src.charCodeAt(pos + want) === c;
            var beforeLong = pos - 1 >= startIdx && src.charCodeAt(pos - 1) === c;
            if (!afterLong && !beforeLong) { found = pos; break; }
            off2 = sub.indexOf(needle2, off2 + 1);
          }
          budget -= (windowEnd2 - startIdx);
        }

        if (found < 0) {
          // No closer in the lookahead window: emit the whole run literally in one
          // step so pathological input cannot degrade into per-char rescans.
          plain += repeatChar(c, runLen);
          i += runLen;
          continue;
        }

        if (found > startIdx &&
            !/\s/.test(src.charAt(startIdx)) &&
            !/\s/.test(src.charAt(found - 1))) {
          var inner = src.slice(startIdx, found);
          flush();
          var body = inline(inner, depth + 1);
          if (want === 3) out += '<strong><em>' + body + '</em></strong>';
          else if (want === 2) out += (c === 126 ? '<del>' + body + '</del>' : '<strong>' + body + '</strong>');
          else out += '<em>' + body + '</em>';
          i = found + want;
          continue;
        }

        plain += mark;
        i++;
        continue;
      }

      plain += src.charAt(i);
      i++;
    }

    flush();
    return out;
  }

  /* ---------------------------------------------------------------- blocks */

  var HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+([\s\S]*?))?[ \t]*#*[ \t]*$/;
  var HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
  var QUOTE_RE = /^ {0,3}>[ \t]?([\s\S]*)$/;
  var LIST_RE = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)([\s\S]*)$/;
  var SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
  var TABLE_DELIM_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

  function indentOf(line) {
    var width = 0;
    for (var i = 0; i < line.length; i++) {
      var c = line.charCodeAt(i);
      if (c === 32) width++;
      else if (c === 9) width += 4 - (width % 4);
      else break;
    }
    return width;
  }

  function fenceInfo(line) {
    var i = 0;
    var n = line.length;
    while (i < n && i < 4 && line.charCodeAt(i) === 32) i++;
    if (i > 3) return null;
    var ch = line.charCodeAt(i);
    if (ch !== 96 && ch !== 126) return null;
    var start = i;
    while (i < n && line.charCodeAt(i) === ch) i++;
    var run = i - start;
    if (run < 3) return null;
    var info = line.slice(i).trim();
    if (ch === 96 && info.indexOf(BT) >= 0) return null;
    var lang = info.split(/\s+/)[0] || '';
    return { ch: String.fromCharCode(ch), code: ch, run: run, lang: lang };
  }

  function isFenceClose(line, fence) {
    var i = 0;
    var n = line.length;
    while (i < n && line.charCodeAt(i) === 32) i++;
    if (i > 3) return false;
    var count = 0;
    while (i < n && line.charCodeAt(i) === fence.code) { i++; count++; }
    if (count < fence.run) return false;
    while (i < n) {
      var c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
      i++;
    }
    return true;
  }

  function isTableStart(lines, i) {
    if (i + 1 >= lines.length) return false;
    var head = lines[i];
    var delim = lines[i + 1];
    if (head.indexOf('|') < 0) return false;
    if (delim.indexOf('|') < 0) return false;
    if (delim.indexOf('-') < 0) return false;
    return TABLE_DELIM_RE.test(delim);
  }

  function splitRow(row) {
    var s = String(row).trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    var cells = [];
    var cur = '';
    var escaped = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (escaped) { cur += ch; escaped = false; continue; }
      if (ch === '\\') { escaped = true; cur += ch; continue; }
      if (ch === '|') { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    for (var k = 0; k < cells.length; k++) cells[k] = cells[k].trim();
    return cells;
  }

  function alignAttr(a) {
    return a ? ' style="text-align:' + a + '"' : '';
  }

  function renderTable(lines, i) {
    var headCells = splitRow(lines[i]);
    var delims = splitRow(lines[i + 1]);
    var aligns = [];
    for (var d = 0; d < delims.length; d++) {
      var cell = delims[d];
      var left = cell.charAt(0) === ':';
      var right = cell.charAt(cell.length - 1) === ':';
      aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : '');
    }
    var cols = headCells.length;
    var html = '<table><thead><tr>';
    for (var c = 0; c < cols; c++) {
      html += '<th' + alignAttr(aligns[c]) + '>' + inline(headCells[c] || '', 0) + '</th>';
    }
    html += '</tr></thead><tbody>';

    var j = i + 2;
    while (j < lines.length && lines[j].trim() !== '' && lines[j].indexOf('|') >= 0) {
      var row = splitRow(lines[j]);
      html += '<tr>';
      for (var k = 0; k < cols; k++) {
        html += '<td' + alignAttr(aligns[k]) + '>' + inline(row[k] || '', 0) + '</td>';
      }
      html += '</tr>';
      j++;
    }
    html += '</tbody></table>';
    return { html: html, next: j };
  }

  function renderCodeBlock(lang, code) {
    var label = lang ? lang : 'text';
    return '<div class="codeblock">' +
      '<div class="code-head"><span class="code-lang">' + escapeHtml(label) + '</span>' +
      '<button class="code-copy" data-code="' + toBase64(code) + '" aria-label="复制代码">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
        '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
        '<path d="M6 15.5H5.2A1.2 1.2 0 0 1 4 14.3V5.2A1.2 1.2 0 0 1 5.2 4h9.1A1.2 1.2 0 0 1 15.5 5.2V6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
        '</svg><span class="code-copy-txt">复制</span></button></div>' +
      '<pre class="code-body"><code>' + highlight(code, lang) + '</code></pre></div>';
  }

  function parseList(lines, start, baseIndent, depth) {
    var first = LIST_RE.exec(lines[start]);
    var ordered = /\d/.test(first[2].charAt(0));
    var startNum = ordered ? parseInt(first[2], 10) : 1;
    if (!ordered || isNaN(startNum)) startNum = 1;

    var items = [];
    var cur = null;
    var i = start;
    var n = lines.length;

    while (i < n) {
      var line = lines[i];

      if (line.trim() === '') {
        var j = i + 1;
        while (j < n && lines[j].trim() === '') j++;
        if (j >= n) { i = j; break; }
        var nextLine = lines[j];
        var nm = LIST_RE.exec(nextLine);
        var nind = indentOf(nextLine);
        if (nm && nind >= baseIndent && nind <= baseIndent + 1) { i = j; continue; }
        if (nm && nind > baseIndent + 1 && cur && depth < 3) { i = j; continue; }
        if (!nm && nind > baseIndent && cur) { i = j; continue; }
        break;
      }

      var m = LIST_RE.exec(line);
      var ind = indentOf(line);

      if (m && ind < baseIndent) break;

      if (m && ind <= baseIndent + 1) {
        cur = { text: m[4], kids: [] };
        items.push(cur);
        i++;
        continue;
      }

      if (m && ind >= baseIndent + 2) {
        if (!cur) break;
        if (depth < 3) {
          var sub = parseList(lines, i, ind, depth + 1);
          cur.kids.push(sub.html);
          i = sub.next;
        } else {
          i++;
        }
        continue;
      }

      if (cur && ind > baseIndent) {
        var innerFence = fenceInfo(line);
        if (innerFence) {
          var fenceLines = [];
          var fj = i + 1;
          while (fj < n && !isFenceClose(lines[fj], innerFence)) {
            fenceLines.push(lines[fj].replace(/^ {0,8}/, ''));
            fj++;
          }
          cur.kids.push(renderCodeBlock(innerFence.lang, fenceLines.join('\n')));
          i = (fj < n) ? fj + 1 : n;
          continue;
        }
        cur.text += '\n' + line.trim();
        i++;
        continue;
      }

      break;
    }

    var html = ordered ? (startNum === 1 ? '<ol>' : '<ol start="' + startNum + '">') : '<ul>';
    for (var k = 0; k < items.length; k++) {
      var item = items[k];
      var task = /^\[([ xX])\](?:[ \t]+([\s\S]*))?$/.exec(item.text);
      if (task) {
        html += '<li class="task-item"><input type="checkbox" disabled' +
          (task[1].toLowerCase() === 'x' ? ' checked' : '') + '> ' +
          inline(task[2] || '', 0) + item.kids.join('') + '</li>';
      } else {
        html += '<li>' + inline(item.text, 0) + item.kids.join('') + '</li>';
      }
    }
    html += ordered ? '</ol>' : '</ul>';
    return { html: html, next: i };
  }

  function renderBlocks(lines, depth) {
    var out = '';
    var i = 0;
    var n = lines.length;

    while (i < n) {
      var line = lines[i];

      if (line.trim() === '') { i++; continue; }

      var fence = fenceInfo(line);
      if (fence) {
        var codeLines = [];
        var j = i + 1;
        while (j < n && !isFenceClose(lines[j], fence)) {
          codeLines.push(lines[j]);
          j++;
        }
        out += renderCodeBlock(fence.lang, codeLines.join('\n'));
        i = (j < n) ? j + 1 : n;
        continue;
      }

      var hm = HEADING_RE.exec(line);
      if (hm) {
        var level = Math.min(4, hm[1].length);
        out += '<h' + level + '>' + inline(hm[2] || '', 0) + '</h' + level + '>';
        i++;
        continue;
      }

      if (HR_RE.test(line)) {
        out += '<hr>';
        i++;
        continue;
      }

      if (QUOTE_RE.test(line)) {
        var quoteLines = [];
        while (i < n && QUOTE_RE.test(lines[i])) {
          quoteLines.push(QUOTE_RE.exec(lines[i])[1]);
          i++;
        }
        if (depth < 3) {
          out += '<blockquote>' + renderBlocks(quoteLines, depth + 1) + '</blockquote>';
        } else {
          out += '<p>' + inline(quoteLines.join('\n'), 0) + '</p>';
        }
        continue;
      }

      if (LIST_RE.test(line)) {
        var list = parseList(lines, i, indentOf(line), depth);
        out += list.html;
        i = list.next;
        continue;
      }

      if (isTableStart(lines, i)) {
        var table = renderTable(lines, i);
        out += table.html;
        i = table.next;
        continue;
      }

      var buf = [];
      var setext = false;
      while (i < n) {
        var ln = lines[i];
        if (ln.trim() === '') break;

        if (buf.length > 0) {
          if (buf.length === 1) {
            var sm = SETEXT_RE.exec(ln);
            if (sm && !LIST_RE.test(buf[0])) {
              var slevel = sm[1].charAt(0) === '=' ? 1 : 2;
              out += '<h' + slevel + '>' + inline(buf[0].trim(), 0) + '</h' + slevel + '>';
              i++;
              setext = true;
              break;
            }
          }
          if (fenceInfo(ln) || HEADING_RE.test(ln) || HR_RE.test(ln) || QUOTE_RE.test(ln) ||
              LIST_RE.test(ln) || isTableStart(lines, i)) {
            break;
          }
        }

        buf.push(ln);
        i++;
      }

      if (!setext && buf.length) {
        out += '<p>' + inline(buf.join('\n'), 0) + '</p>';
      }
    }

    return out;
  }

  /* ---------------------------------------------------------------- public */

  function render(text, opts) {
    try {
      if (text === null || text === undefined) return '';
      var src = String(text);
      if (src.length > MAX_INPUT) src = src.slice(0, MAX_INPUT);
      src = src.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
      if (!src) return '';
      return renderBlocks(src.split('\n'), 0);
    } catch (err) {
      try {
        return '<p>' + escapeHtml(text === null || text === undefined ? '' : String(text)) + '</p>';
      } catch (e2) {
        return '';
      }
    }
  }

  root.CodexMarkdown = {
    render: render,
    escapeHtml: escapeHtml,
    version: '1.0.0'
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
