"""Offline fixture preparation; reads supplied HTML only, never starts a browser or loads URLs."""
import hashlib
import json
from html.parser import HTMLParser
from pathlib import Path
import sys

VOID = set('area base br col embed hr img input link meta param source track wbr'.split())
SELECTED_IDS = {'activity-name', 'meta_content', 'js_content'}


class Parser(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.source = source
        self.lines = [0]
        for index, character in enumerate(source):
            if character == '\n':
                self.lines.append(index + 1)
        self.root = {'tag': 'body', 'attrs': {}, 'children': []}
        self.stack = [self.root]
        self.selected = []
        self.scripts = []
        self.feed(source)

    def position(self):
        line, column = self.getpos()
        return self.lines[line - 1] + column

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        node = {'tag': tag, 'attrs': attributes, 'children': [], 'start': self.position()}
        self.stack[-1]['children'].append(node)
        classes = str(attributes.get('class') or '').split()
        if attributes.get('id') in SELECTED_IDS or 'interaction_bar' in classes:
            self.selected.append(node)
        if tag == 'script':
            self.scripts.append(node)
        if tag in VOID:
            node['end'] = self.position() + len(self.get_starttag_text())
        else:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.stack[-1]['end'] = self.position() + len(self.get_starttag_text())
            self.stack.pop()

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index]['tag'] == tag:
                self.stack[index]['end'] = self.source.index('>', self.position()) + 1
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1]['children'].append(data)


def tree(node):
    if isinstance(node, str):
        return node
    return [node['tag'], node['attrs'], [tree(child) for child in node['children']]]


if __name__ == '__main__':
    source_dir = Path(sys.argv[1])
    destination = Path(__file__).parent
    for filename in sorted(source_dir.glob('*.html')):
        source = filename.read_text()
        parsed = Parser(source)
        fragments = []
        for node in parsed.selected:
            start, end = node['start'], node['end']
            fragment = source[start:end]
            for script in reversed(parsed.scripts):
                if start <= script['start'] < script['end'] <= end:
                    fragment = fragment[:script['start'] - start] + fragment[script['end'] - start:]
            fragments.append(fragment)
        html = '<!doctype html>\n<html><body>\n' + '\n'.join(fragments) + '\n</body></html>\n'
        sanitized = Parser(html)
        assert not sanitized.scripts
        target = destination / filename.name
        target.write_text(html)
        snapshot = {'source': f'output/wechat-articles/live-dom-20261109/{filename.name}',
                    'sourceSha256': hashlib.sha256(source.encode()).hexdigest(),
                    'htmlSha256': hashlib.sha256(html.encode()).hexdigest(),
                    'provenance': 'user_provided_live_dom_20261109',
                    'url': f'https://mp.weixin.qq.com/s/{filename.stem}',
                    'tree': tree(sanitized.root)}
        target.with_suffix('.tree.json').write_text(json.dumps(snapshot, ensure_ascii=False) + '\n')
        print(filename.name, len(html.encode()), 'bytes, no scripts')
