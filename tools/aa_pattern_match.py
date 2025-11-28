#!/usr/bin/env python3
"""
エッジ画像から漢字パターンマッチングでAA生成
"""

import numpy as np
from PIL import Image, ImageDraw, ImageFont
import os
import sys

# 漢字セット（形状の多様性を重視）
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
print(f"漢字セット: {len(KANJI_LIST)}文字")


def create_char_bitmap(char, size, font):
    """文字を二値ビットマップに変換"""
    img = Image.new('L', (size, size), 0)  # 黒背景
    draw = ImageDraw.Draw(img)

    # 文字を中央に配置
    bbox = draw.textbbox((0, 0), char, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - w) // 2 - bbox[0]
    y = (size - h) // 2 - bbox[1]
    draw.text((x, y), char, font=font, fill=255)  # 白で描画

    # 二値化
    return np.array(img) > 128


def load_font(size):
    """フォント読み込み"""
    size = max(size, 10)  # 最小フォントサイズ
    windows_fonts = [
        "C:/Windows/Fonts/msgothic.ttc",
        "C:/Windows/Fonts/meiryo.ttc",
        "C:/Windows/Fonts/YuGothM.ttc",
    ]
    for f in windows_fonts:
        if os.path.exists(f):
            return ImageFont.truetype(f, size - 2)
    return ImageFont.load_default()


def pattern_match(cell, char_bitmaps):
    """セルと最もマッチする漢字を探す"""
    best_char = '　'
    best_score = -1

    cell_white_ratio = cell.mean()

    # ほぼ真っ黒ならスペース
    if cell_white_ratio < 0.02:
        return '　'

    # ほぼ真っ白なら■
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

        # XNORで一致率計算
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
    input_path = sys.argv[1] if len(sys.argv) > 1 else 'docs/images/kirinuki_indo_sobel_binary_30.png'
    output_width = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    output_height = int(sys.argv[3]) if len(sys.argv) > 3 else 200

    print(f"入力: {input_path}")
    print(f"出力サイズ: {output_width}x{output_height}文字")

    # 画像読み込み
    img = np.array(Image.open(input_path).convert('L')) > 128
    h, w = img.shape
    print(f"画像サイズ: {w}x{h}")

    # セルサイズ
    cell_h = h // output_height
    cell_w = w // output_width
    print(f"セルサイズ: {cell_w}x{cell_h}px")

    # 漢字ビットマップを事前計算
    char_size = max(cell_w, cell_h)
    font = load_font(char_size)

    print(f"漢字ビットマップ生成中... (サイズ: {char_size}x{char_size})")
    char_bitmaps = {}
    for char in KANJI_LIST:
        char_bitmaps[char] = create_char_bitmap(char, char_size, font)

    # 特殊文字
    char_bitmaps['　'] = np.zeros((char_size, char_size), dtype=bool)
    char_bitmaps['■'] = np.ones((char_size, char_size), dtype=bool)

    print("AA生成中...")
    result = []
    for row in range(output_height):
        line = ""
        for col in range(output_width):
            y1 = row * cell_h
            y2 = min(y1 + cell_h, h)
            x1 = col * cell_w
            x2 = min(x1 + cell_w, w)

            cell = img[y1:y2, x1:x2]

            if cell.size == 0:
                line += '　'
                continue

            char = pattern_match(cell, char_bitmaps)
            line += char

        result.append(line)

        if (row + 1) % 20 == 0:
            print(f"進捗: {row + 1}/{output_height}行")

    aa_text = '\n'.join(result)

    # 保存
    output_path = os.path.splitext(input_path)[0] + f'_aa_{output_width}x{output_height}.txt'
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(aa_text)
    print(f"\n保存: {output_path}")

    # プレビュー（中央部分）
    print("\n=== プレビュー（中央50行） ===")
    mid = len(result) // 2
    for line in result[mid-25:mid+25]:
        print(line)


if __name__ == "__main__":
    main()
