"""Build the printable manual. Requires reportlab; run from any directory."""
from html import escape
from pathlib import Path
import re

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / 'BimmerStein-Bin-Analyzer-User-Manual.pdf'
BLUE = colors.HexColor('#1764a5')
INK = colors.HexColor('#243449')
WIDTH = A4[0] - 88


def slug(text):
    return re.sub(r'[^\w -]', '', text.lower()).replace(' ', '-')


def inline(text):
    text = escape(text)
    text = re.sub(r'`([^`]+)`', r'<font name="Courier" color="#1764a5">\1</font>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', text)
    return re.sub(r'\[([^]]+)\]\(([^)]+)\)', lambda m: (
        f'<link href="{m[2]}" color="#1764a5">{m[1]}</link>'
        if m[2].startswith(('https://', '#')) else m[1]), text)


def build():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle('BodyTextManual', fontName='Helvetica', fontSize=10,
                              leading=14.5, textColor=INK, spaceAfter=8))
    styles.add(ParagraphStyle('CoverTitle', fontName='Helvetica-Bold', fontSize=26,
                              leading=31, textColor=BLUE, spaceBefore=14, spaceAfter=14,
                              alignment=TA_CENTER))
    styles.add(ParagraphStyle('Section', fontName='Helvetica-Bold', fontSize=17,
                              leading=22, textColor=BLUE, spaceBefore=14, spaceAfter=10,
                              keepWithNext=True))
    styles.add(ParagraphStyle('Subsection', parent=styles['Section'], fontSize=12,
                              leading=17, spaceBefore=10, spaceAfter=6))
    styles.add(ParagraphStyle('Cell', parent=styles['BodyTextManual'], fontSize=9,
                              leading=12, spaceAfter=0))
    styles.add(ParagraphStyle('Caption', parent=styles['BodyTextManual'], fontSize=8,
                              leading=11, textColor=colors.HexColor('#596a7a'),
                              alignment=TA_CENTER, spaceAfter=12))
    styles.add(ParagraphStyle('ListBody', parent=styles['BodyTextManual'], leftIndent=15, bulletIndent=0))
    # Use a Unicode font when building on Windows, with portable PDF fonts as fallback.
    import os
    fonts = Path(os.environ.get('WINDIR', '/nonexistent')) / 'Fonts'
    if (fonts / 'segoeui.ttf').exists():
        for name, file in [('Manual', 'segoeui.ttf'), ('Manual-Bold', 'segoeuib.ttf')]:
            pdfmetrics.registerFont(TTFont(name, str(fonts / file)))
        pdfmetrics.registerFontFamily('Manual', normal='Manual', bold='Manual-Bold',
                                      italic='Manual', boldItalic='Manual-Bold')
        for name in ['BodyTextManual', 'Cell', 'Caption', 'ListBody']:
            styles[name].fontName = 'Manual'
        for name in ['CoverTitle', 'Section', 'Subsection']:
            styles[name].fontName = 'Manual-Bold'

    story = []
    lines = (ROOT / 'USER_MANUAL.md').read_text(encoding='utf-8').splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line or line == '---':
            i += 1
            continue
        if line == '<!-- pagebreak -->':
            story.append(PageBreak())
            i += 1
            continue
        heading = re.match(r'^(#{1,3}) (.+)$', line)
        if heading:
            level, title = len(heading[1]), heading[2]
            chapter = re.match(r'^(\d+)\.', title)
            if level == 2 and chapter and int(chapter[1]) >= 3:
                story.append(PageBreak())
            if level == 1:
                logo = ROOT.parent / 'apps/desktop/src-tauri/icons/128x128@2x.png'
                story.append(Image(str(logo), width=65, height=65))
            style = styles['CoverTitle' if level == 1 else 'Section' if level == 2 else 'Subsection']
            story.append(Paragraph(f'<a name="{slug(title)}"/>{inline(title)}', style))
            i += 1
            continue
        picture = re.fullmatch(r'!\[([^]]*)\]\(([^)]+)\)', line)
        if picture:
            image = Image(str(ROOT / picture[2]))
            scale = min(WIDTH / image.imageWidth, 360 / image.imageHeight, 1)
            image.drawWidth, image.drawHeight = image.imageWidth * scale, image.imageHeight * scale
            image.hAlign = 'CENTER'
            story.append(KeepTogether([Spacer(1, 5), image, Spacer(1, 5), Paragraph(inline(picture[1]), styles['Caption'])]))
            i += 1
            continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r'[-:]+', c) for c in cells):
                    rows.append([Paragraph(inline(c), styles['Cell']) for c in cells])
                i += 1
            widths = [WIDTH * 0.34, WIDTH * 0.66] if len(rows[0]) == 2 else [WIDTH * 0.22, WIDTH * 0.50, WIDTH * 0.28]
            table = Table(rows, colWidths=widths, repeatRows=1, hAlign='LEFT')
            table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e5eff8')),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f5f7fa')]),
                ('LINEBELOW', (0, 0), (-1, 0), 0.6, BLUE),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 8), ('RIGHTPADDING', (0, 0), (-1, -1), 8),
                ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ]))
            story.extend([table, Spacer(1, 10)])
            continue
        bullet = re.match(r'^(\d+\.|-) (.+)', line)
        paragraph = bullet[2] if bullet else line
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r'^(#|\||!\[|<!--|\d+\. |\- )', lines[i].strip()):
            paragraph += ' ' + lines[i].strip()
            i += 1
        story.append(Paragraph(inline(paragraph), styles['ListBody' if bullet else 'BodyTextManual'],
                               bulletText=(bullet[1] if bullet[1] != '-' else '\u2022') if bullet else None))

    def page_chrome(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor('#c8d9e9'))
        canvas.line(44, 38, A4[0] - 44, 38)
        canvas.setFillColor(colors.HexColor('#596a7a'))
        canvas.setFont('Helvetica', 8)
        canvas.drawString(44, 25, 'BimmerStein Bin Analyzer | User Manual | 0.2.18')
        canvas.drawRightString(A4[0] - 44, 25, str(doc.page))
        canvas.restoreState()

    doc = SimpleDocTemplate(str(OUTPUT), pagesize=A4, rightMargin=44, leftMargin=44,
                            topMargin=38, bottomMargin=52, title='BimmerStein Bin Analyzer User Manual',
                            author='Cristian Ayon', subject='Version 0.2.18 - Windows x64')
    doc.build(story, onFirstPage=page_chrome, onLaterPages=page_chrome)
    print(OUTPUT)


if __name__ == '__main__':
    build()
