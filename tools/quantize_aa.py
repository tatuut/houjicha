#!/usr/bin/env python3
"""
AAテキストを量子化（高解像度AA → 低解像度AA）
判定時は文字を太くして被り面積を増やし、出力は通常太さ
"""

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os
import sys


# 漢字セット（aa_pattern_match.pyと同じ）
KANJI_SET = """
人八川山木林森轟響鬱驫麟龍鑿
口田目日月火水土金石玉王
一二三十千万丁了又工士
上下左右中大小少多高低
出入分切刀力矢弓心戈手
門開閉雨雲風空気天地
東西南北角丸点線面体
父母子女男兄弟姉妹夫妻
言語話声音歌詩文字書
見視目耳口鼻手足頭首
走歩飛跳立座寝起食飲
生死活殺産育老病傷痛
思考想念願望欲求探索
造建設破壊修復改変換
勝負戦闘争競協助援救
光影陰陽明暗昼夜朝晩
"""

KANJI_LIST = list(set(KANJI_SET.replace('\n', '').replace(' ', '')))


def load_font(size):
    """フォント読み込み"""
    size = max(size, 10)
    windows_fonts = [
        "C:/Windows/Fonts/msgothic.ttc",
        "C:/Windows/Fonts/meiryo.ttc",
        "C:/Windows/Fonts/YuGothM.ttc",
    ]
    for f in windows_fonts:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def create_char_bitmap(char, size, font, bold=False):
    """文字を二値ビットマップに変換（boldで太くする）"""
    img = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(img)

    bbox = draw.textbbox((0, 0), char, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - w) // 2 - bbox[0]
    y = (size - h) // 2 - bbox[1]
    draw.text((x, y), char, font=font, fill=255)

    if bold:
        # 膨張処理で太くする
        img = img.filter(ImageFilter.MaxFilter(3))

    return np.array(img) > 128


def render_aa_to_image(aa_lines, char_size, font):
    """AAテキストを画像にレンダリング"""
    height = len(aa_lines)
    width = max(len(line) for line in aa_lines)

    img = Image.new('L', (width * char_size, height * char_size), 0)
    draw = ImageDraw.Draw(img)

    for row, line in enumerate(aa_lines):
        for col, char in enumerate(line):
            if char == '　' or char == ' ':
                continue
            x = col * char_size
            y = row * char_size
            # 文字を中央に配置
            bbox = draw.textbbox((0, 0), char, font=font)
            cx = x + (char_size - (bbox[2] - bbox[0])) // 2 - bbox[0]
            cy = y + (char_size - (bbox[3] - bbox[1])) // 2 - bbox[1]
            draw.text((cx, cy), char, font=font, fill=255)

    return np.array(img) > 128


def pattern_match(cell, char_bitmaps):
    """セルと最もマッチする漢字を探す（XNOR：白同士も黒同士も評価）"""
    best_char = '　'
    best_score = -1

    cell_white_ratio = cell.mean()

    if cell_white_ratio < 0.02:
        return '　'

    if cell_white_ratio > 0.95:
        return '■'

    for char, bitmap in char_bitmaps.items():
        if char in ['　', '■']:
            continue

        # リサイズ
        if cell.shape != bitmap.shape:
            cell_resized = np.array(
                Image.fromarray(cell.astype(np.uint8) * 255)
                .resize(bitmap.shape[::-1], Image.NEAREST)
            ) > 128
        else:
            cell_resized = cell

        # XNOR：白同士も黒同士も一致として評価
        match = np.mean(cell_resized == bitmap)

        # 白の割合も考慮
        bitmap_white_ratio = bitmap.mean()
        ratio_penalty = abs(cell_white_ratio - bitmap_white_ratio) * 0.3

        score = match - ratio_penalty

        if score > best_score:
            best_score = score
            best_char = char

    return best_char


def main():
    input_path = sys.argv[1] if len(sys.argv) > 1 else 'docs/images/kirinuki_indo_face_aa_80x92.txt'
    output_width = int(sys.argv[2]) if len(sys.argv) > 2 else 16
    output_height = int(sys.argv[3]) if len(sys.argv) > 3 else 20

    print(f"入力: {input_path}")
    print(f"出力サイズ: {output_width}x{output_height}文字")

    # AAテキスト読み込み
    with open(input_path, 'r', encoding='utf-8') as f:
        aa_lines = [line.rstrip('\n') for line in f.readlines()]

    input_height = len(aa_lines)
    input_width = max(len(line) for line in aa_lines)
    print(f"入力AAサイズ: {input_width}x{input_height}文字")

    # 文字サイズ（レンダリング用）
    char_size = 16  # 各文字を16x16pxでレンダリング
    font = load_font(char_size)

    print("AAを画像にレンダリング中...")
    aa_image = render_aa_to_image(aa_lines, char_size, font)
    print(f"レンダリング画像サイズ: {aa_image.shape[1]}x{aa_image.shape[0]}px")

    # セルサイズ
    cell_h = aa_image.shape[0] // output_height
    cell_w = aa_image.shape[1] // output_width
    print(f"セルサイズ: {cell_w}x{cell_h}px")

    # 判定用ビットマップ（太字）
    match_char_size = max(cell_w, cell_h, 16)
    match_font = load_font(match_char_size)

    print(f"判定用ビットマップ生成中（太字、サイズ: {match_char_size}x{match_char_size}）...")
    char_bitmaps_bold = {}
    for char in KANJI_LIST:
        char_bitmaps_bold[char] = create_char_bitmap(char, match_char_size, match_font, bold=True)

    char_bitmaps_bold['　'] = np.zeros((match_char_size, match_char_size), dtype=bool)
    char_bitmaps_bold['■'] = np.ones((match_char_size, match_char_size), dtype=bool)

    print("量子化中...")
    result = []
    for row in range(output_height):
        line = ""
        for col in range(output_width):
            y1 = row * cell_h
            y2 = min(y1 + cell_h, aa_image.shape[0])
            x1 = col * cell_w
            x2 = min(x1 + cell_w, aa_image.shape[1])

            cell = aa_image[y1:y2, x1:x2]

            if cell.size == 0:
                line += '　'
                continue

            char = pattern_match(cell, char_bitmaps_bold)
            line += char

        result.append(line)
        print(f"進捗: {row + 1}/{output_height}行")

    aa_text = '\n'.join(result)

    # 保存
    base_name = os.path.splitext(input_path)[0]
    output_path = f"{base_name}_q{output_width}x{output_height}.txt"
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(aa_text)
    print(f"\n保存: {output_path}")

    # プレビュー
    print("\n=== 量子化結果 ===")
    for line in result:
        print(line)


if __name__ == "__main__":
    main()
