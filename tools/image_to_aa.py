#!/usr/bin/env python3
"""
画像→AA変換ツール（高品質版）
- 128x128ビットマップで漢字マッチング
- 色素縮約によるエッジ強調
- 二値化後のパターンマッチング
"""

import numpy as np
from PIL import Image, ImageDraw, ImageFont
import sys
import os

# ============================================================
# 漢字セット（約500文字）
# - 濃度・パターンが多様な漢字を選定
# - 単純すぎる漢字（一、二など）は除外
# - 画数と塗り面積のバランスを考慮
# ============================================================
KANJI_SET = """
顔頭首肩腕腰背胸腹指爪鼻眉唇額頬顎耳
森林木花草竹石雲雨雪星炎波浪渦滝霧霞
東西南北角丸線縦横斜曲輪環周囲枠窓扉
高低長短広狭深浅厚薄軽重強弱速遅濃淡
赤青黄緑紫橙灰銀銅鉄玉珠宝翠碧琥珀瑠
父母兄弟姉妹夫妻男女王君臣師友敵侍武
食飲料理肉魚米麦豆菜果茶酒塩糖油酢醤
言語話読書聞声音歌詩句章節段落編綴詠
見視観察看守護衛監督指導教育学習練修
走歩飛跳泳登降乗越渡送届届届届届届届届
持握放投捕掴押引切割刺突打叩殴蹴踏蹂
開閉入出発着始終続休眠起寝覚醒夢想幻
死活殺産育養老病傷痛苦楽喜怒哀悲恐驚
思考想像記憶忘念願望欲求探索調査研究
造建設破壊修復改変換移動転回旋巡循環
離結解散集積貯蓄消費売買貸借払受授与
勝負戦争闘競協助援救済保険護防攻撃襲
暗光影陰陽昼夜朝晩春夏秋冬寒暖温涼熱
旧古今昔未来過去現在永久瞬間刻限期際
偽誤善悪美醜清濁純雑単複簡難易困惑迷
異等差別特普通常非凡均標準基本応用実
半部分完欠満空虚在存有無限界境域圏層
態勢姿容貌相面表裏側端辺隅囲環縁際境
線面体積容量質材料素原因果関係連鎖絆
量度割比率倍増減加算乗除余剰端数値量
置場所地点方向角度距離速度加減速緩急
圧量密度硬軟弾性張摩擦抵抗反発撥弾躍
冷温度湿乾燥蒸発凝結融解固液気体煙霧
磁波動振震響鳴轟爆炸裂砕粉塵埃泥沼池
械器具道具装置設備施設建物構造組織網
律規則制度政治経済社会文化歴史伝統革
家民族人種言葉文字記号符号暗号信号旗
船飛機列電鉄道路橋港空駅停留場駐輪館
舗商館工場農園漁港鉱林業牧畜酪醸造窯
業仕事労働勤務休暇退職転職就職採用募
紙幣貨硬券株債権利義務責任担保証拠跡
院医者看護師薬剤処方診療検査手術治癒
校教室師徒生児童園児幼稚保育託養護介
神社仏教道儒督回蘭徒僧侶尼禅祈祷祭礼
服着物洋服和装礼装制服私服普段着寝巻
居家屋部屋台所風呂便所玄関廊階段屋根
家電冷蔵庫洗濯機掃除機炊飯器湯沸乾燥
龍鳳凰虎獅象鯨鷹鶴亀蛇蝶蜂蟻蝉蛙蜘蛛
雷電稲妻閃光輝煌燦爛燈灯篝炬焔焰熾烈
鋼鍛錬鋳銃剣槍矛盾甲冑兜鎧弓矢弩砲弾
織編縫繍刺紡績染晒漂糊糸綿麻絹毛皮革
彫刻塑像絵画描写素描輪郭陰影濃淡彩色
"""

# 重複を除去してリスト化
KANJI_LIST = list(set(KANJI_SET.replace('\n', '').replace(' ', '')))
print(f"漢字セット: {len(KANJI_LIST)}文字")


class ImageToAA:
    def __init__(self, char_size=128, font_path=None):
        """
        Args:
            char_size: 文字ビットマップのサイズ（128x128推奨）
            font_path: フォントファイルのパス（Noneならシステムフォント）
        """
        self.char_size = char_size
        self.font = self._load_font(font_path)
        self.char_bitmaps = {}  # 文字→ビットマップのキャッシュ

    def _load_font(self, font_path):
        """フォント読み込み"""
        if font_path and os.path.exists(font_path):
            return ImageFont.truetype(font_path, self.char_size - 10)

        # Windowsのシステムフォントを試す
        windows_fonts = [
            "C:/Windows/Fonts/msgothic.ttc",  # MSゴシック
            "C:/Windows/Fonts/meiryo.ttc",     # メイリオ
            "C:/Windows/Fonts/YuGothM.ttc",    # 游ゴシック
        ]
        for f in windows_fonts:
            if os.path.exists(f):
                return ImageFont.truetype(f, self.char_size - 10)

        # フォールバック
        return ImageFont.load_default()

    def _char_to_bitmap(self, char):
        """文字を二値ビットマップに変換"""
        if char in self.char_bitmaps:
            return self.char_bitmaps[char]

        # 文字を描画
        img = Image.new('L', (self.char_size, self.char_size), 255)
        draw = ImageDraw.Draw(img)

        # 文字を中央に配置
        bbox = draw.textbbox((0, 0), char, font=self.font)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        x = (self.char_size - w) // 2 - bbox[0]
        y = (self.char_size - h) // 2 - bbox[1]
        draw.text((x, y), char, font=self.font, fill=0)

        # 二値化
        bitmap = np.array(img) < 128
        self.char_bitmaps[char] = bitmap
        return bitmap

    def _precompute_char_bitmaps(self, chars):
        """全文字のビットマップを事前計算"""
        print(f"文字ビットマップを生成中... ({len(chars)}文字)")
        for i, char in enumerate(chars):
            self._char_to_bitmap(char)
            if (i + 1) % 100 == 0:
                print(f"  {i + 1}/{len(chars)}")
        print("完了!")

        # 黒塗りつぶし・白塗りつぶしも追加
        self.char_bitmaps['■'] = np.ones((self.char_size, self.char_size), dtype=bool)
        self.char_bitmaps['□'] = np.zeros((self.char_size, self.char_size), dtype=bool)

    def _color_condensation(self, boxel):
        """
        色素縮約: 分散に応じて濃い方へシフト
        分散が大きい（エッジがある）ところはコントラスト強調
        """
        variance = np.var(boxel)
        if variance < 1:  # ほぼ均一
            return boxel

        # 分散に応じたシフト強度
        max_variance = 255 * 255 / 4  # 理論最大分散
        shift_strength = min(variance / max_variance, 1.0) * 0.5

        # 中央値より暗いピクセルをより暗く、明るいピクセルをより明るく
        median = np.median(boxel)
        result = boxel.copy().astype(float)

        dark_mask = boxel < median
        light_mask = boxel >= median

        # 暗い部分をより暗く
        result[dark_mask] = boxel[dark_mask] * (1 - shift_strength)
        # 明るい部分をより明るく
        result[light_mask] = boxel[light_mask] + (255 - boxel[light_mask]) * shift_strength

        return np.clip(result, 0, 255).astype(np.uint8)

    def _binarize(self, boxel):
        """二値化（大津の方法）"""
        # 大津の方法で最適な閾値を計算
        hist, bins = np.histogram(boxel.flatten(), bins=256, range=(0, 256))
        total = boxel.size

        sum_total = np.sum(np.arange(256) * hist)
        sum_bg = 0
        weight_bg = 0
        max_variance = 0
        threshold = 0

        for i in range(256):
            weight_bg += hist[i]
            if weight_bg == 0:
                continue
            weight_fg = total - weight_bg
            if weight_fg == 0:
                break

            sum_bg += i * hist[i]
            mean_bg = sum_bg / weight_bg
            mean_fg = (sum_total - sum_bg) / weight_fg

            variance = weight_bg * weight_fg * (mean_bg - mean_fg) ** 2
            if variance > max_variance:
                max_variance = variance
                threshold = i

        return boxel < threshold

    def _match_char(self, boxel_binary, chars):
        """
        二値化されたboxelに最もマッチする文字を探す
        """
        best_char = ' '
        best_score = -1

        # 黒/白の割合をチェック
        black_ratio = np.mean(boxel_binary)

        # ほぼ真っ白ならスペース
        if black_ratio < 0.03:
            return ' '

        # ほぼ真っ黒なら■
        if black_ratio > 0.97:
            return '■'

        # boxelをビットマップサイズにリサイズ（一度だけ）
        if boxel_binary.shape != (self.char_size, self.char_size):
            boxel_resized = np.array(
                Image.fromarray(boxel_binary.astype(np.uint8) * 255)
                .resize((self.char_size, self.char_size), Image.NEAREST)
            ) > 128
        else:
            boxel_resized = boxel_binary

        for char in chars:
            bitmap = self.char_bitmaps.get(char)
            if bitmap is None:
                continue

            # 合致率（XNORの平均）
            match = np.mean(boxel_resized == bitmap)

            # 黒の分布も考慮（同じ黒率の文字を優先）
            char_black_ratio = np.mean(bitmap)
            ratio_diff = abs(black_ratio - char_black_ratio)
            adjusted_score = match - ratio_diff * 0.3

            if adjusted_score > best_score:
                best_score = adjusted_score
                best_char = char

        # 合致率が低すぎる場合
        if best_score < 0.5:
            # 黒が少なければスペース寄り、多ければ濃い文字
            if black_ratio < 0.2:
                return '　'  # 全角スペース
            elif black_ratio > 0.7:
                return '■'

        return best_char

    def convert(self, image_path, output_width=60, output_height=None):
        """
        画像をAAに変換

        Args:
            image_path: 入力画像パス
            output_width: 出力AA幅（文字数）
            output_height: 出力AA高さ（Noneなら比率維持）

        Returns:
            AA文字列
        """
        # 文字ビットマップを事前計算
        self._precompute_char_bitmaps(KANJI_LIST)

        # 画像読み込み
        print(f"画像読み込み: {image_path}")
        img = Image.open(image_path)

        # アルファチャンネル処理
        if img.mode == 'RGBA':
            # アルファチャンネルを取得
            alpha = np.array(img.split()[3])
            # RGB部分をグレースケールに
            img_rgb = img.convert('RGB')
            img_gray = img_rgb.convert('L')
            img_array = np.array(img_gray)
            # 透明部分を白(255)に
            img_array = np.where(alpha < 128, 255, img_array)
        else:
            # モノクロ化
            img_gray = img.convert('L')
            img_array = np.array(img_gray)

        # コントラスト強調（ヒストグラム均等化）
        # 非透明部分のみで正規化
        non_white_mask = img_array < 250
        if np.any(non_white_mask):
            min_val = img_array[non_white_mask].min()
            max_val = img_array[non_white_mask].max()
            if max_val > min_val:
                img_array = np.where(
                    non_white_mask,
                    ((img_array - min_val) / (max_val - min_val) * 255).astype(np.uint8),
                    255
                )

        print(f"元画像サイズ: {img_array.shape}")

        # 出力サイズ計算
        h, w = img_array.shape
        if output_height is None:
            # アスペクト比維持（文字は縦長なので補正）
            output_height = int(output_width * h / w * 0.5)

        print(f"出力サイズ: {output_width}x{output_height}文字")

        # Boxelサイズ
        boxel_h = h // output_height
        boxel_w = w // output_width

        print(f"Boxelサイズ: {boxel_w}x{boxel_h}px")

        # AA生成
        result = []
        for row in range(output_height):
            line = ""
            for col in range(output_width):
                # Boxel切り出し
                y1 = row * boxel_h
                y2 = min(y1 + boxel_h, h)
                x1 = col * boxel_w
                x2 = min(x1 + boxel_w, w)

                boxel = img_array[y1:y2, x1:x2]

                if boxel.size == 0:
                    line += ' '
                    continue

                # 平均輝度を計算
                avg_brightness = np.mean(boxel)

                # 輝度で文字を選択（濃度順に並べた漢字）
                # より細かい24段階グラデーション
                # 薄い→濃い: スペース→点→線→簡単な漢字→複雑な漢字→塗りつぶし
                DENSITY_CHARS = [
                    '　',  # 白（透明）
                    '　',  # ほぼ白
                    '.',   # 点
                    '･',   # 中点
                    '°',   # 度
                    '゜',  # 半濁点
                    '`',   # バッククォート
                    ':',   # コロン
                    ';',   # セミコロン
                    '人',  # 簡単な漢字
                    '八',  #
                    '川',  #
                    '山',  #
                    '村',  #
                    '林',  #
                    '森',  #
                    '轟',  #
                    '響',  #
                    '鬱',  #
                    '驫',  #
                    '麟',  #
                    '龍',  #
                    '鑿',  #
                    '■',  # 塗りつぶし
                ]

                # 輝度を0-23のインデックスにマッピング
                # 高輝度（白）= 0、低輝度（黒）= 23
                idx = int((255 - avg_brightness) / 256 * len(DENSITY_CHARS))
                idx = max(0, min(len(DENSITY_CHARS) - 1, idx))
                char = DENSITY_CHARS[idx]

                line += char

            result.append(line)
            if (row + 1) % 10 == 0:
                print(f"進捗: {row + 1}/{output_height}行")

        return '\n'.join(result)


def main():
    if len(sys.argv) < 2:
        print("Usage: python image_to_aa.py <image_path> [width] [height]")
        print("Example: python image_to_aa.py input.png 60 30")
        sys.exit(1)

    image_path = sys.argv[1]
    width = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    height = int(sys.argv[3]) if len(sys.argv) > 3 else None

    converter = ImageToAA(char_size=128)
    aa = converter.convert(image_path, output_width=width, output_height=height)

    print("\n" + "="*60)
    print("生成されたAA:")
    print("="*60)
    print(aa)

    # ファイル出力
    output_path = os.path.splitext(image_path)[0] + "_aa.txt"
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(aa)
    print(f"\n保存先: {output_path}")


if __name__ == "__main__":
    main()
