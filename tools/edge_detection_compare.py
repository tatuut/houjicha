#!/usr/bin/env python3
"""
エッジ検出アルゴリズム比較ツール
各手法の結果を画像として保存して目視比較する
"""

import numpy as np
from PIL import Image
import os
import sys

def load_image(path):
    """画像をグレースケールで読み込み"""
    img = Image.open(path)

    # アルファチャンネル処理
    if img.mode == 'RGBA':
        alpha = np.array(img.split()[3])
        img_gray = img.convert('RGB').convert('L')
        img_array = np.array(img_gray, dtype=np.float64)
        # 透明部分を白に
        img_array = np.where(alpha < 128, 255, img_array)
    else:
        img_array = np.array(img.convert('L'), dtype=np.float64)

    return img_array


def sobel_edge(img):
    """Sobel演算子によるエッジ検出"""
    # カーネル
    Gx = np.array([[-1, 0, 1],
                   [-2, 0, 2],
                   [-1, 0, 1]], dtype=np.float64)

    Gy = np.array([[-1, -2, -1],
                   [ 0,  0,  0],
                   [ 1,  2,  1]], dtype=np.float64)

    # 畳み込み
    edge_x = convolve(img, Gx)
    edge_y = convolve(img, Gy)

    # 合成（マグニチュード）
    magnitude = np.sqrt(edge_x**2 + edge_y**2)

    # 方向（-π〜πをラジアンで）
    direction = np.arctan2(edge_y, edge_x)

    return {
        'x': normalize(edge_x),
        'y': normalize(edge_y),
        'magnitude': normalize(magnitude),
        'direction': direction
    }


def canny_edge(img, low_threshold=50, high_threshold=150):
    """Cannyエッジ検出"""
    # 1. ガウシアンぼかし
    blurred = gaussian_blur(img, sigma=1.4)

    # 2. Sobelでグラディエント
    Gx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float64)
    Gy = np.array([[-1, -2, -1], [0, 0, 0], [1, 2, 1]], dtype=np.float64)

    edge_x = convolve(blurred, Gx)
    edge_y = convolve(blurred, Gy)

    magnitude = np.sqrt(edge_x**2 + edge_y**2)
    direction = np.arctan2(edge_y, edge_x)

    # 3. Non-maximum suppression
    nms = non_max_suppression(magnitude, direction)

    # 4. ヒステリシス閾値処理
    result = hysteresis_threshold(nms, low_threshold, high_threshold)

    return {
        'blurred': normalize(blurred),
        'nms': normalize(nms),
        'result': result.astype(np.float64) * 255
    }


def laplacian_edge(img):
    """Laplacianエッジ検出"""
    # まずガウシアンぼかし（ノイズ軽減）
    blurred = gaussian_blur(img, sigma=1.0)

    # 4近傍Laplacian
    kernel_4 = np.array([[ 0, -1,  0],
                         [-1,  4, -1],
                         [ 0, -1,  0]], dtype=np.float64)

    # 8近傍Laplacian
    kernel_8 = np.array([[-1, -1, -1],
                         [-1,  8, -1],
                         [-1, -1, -1]], dtype=np.float64)

    lap_4 = convolve(blurred, kernel_4)
    lap_8 = convolve(blurred, kernel_8)

    return {
        '4neighbor': normalize(np.abs(lap_4)),
        '8neighbor': normalize(np.abs(lap_8))
    }


def dog_edge(img, sigma1=1.0, sigma2=2.0):
    """Difference of Gaussians"""
    blur1 = gaussian_blur(img, sigma1)
    blur2 = gaussian_blur(img, sigma2)

    dog = blur1 - blur2

    # 複数のスケールも試す
    blur3 = gaussian_blur(img, sigma2 * 2)
    dog2 = blur2 - blur3

    return {
        f'sigma_{sigma1}_{sigma2}': normalize(np.abs(dog)),
        f'sigma_{sigma2}_{sigma2*2}': normalize(np.abs(dog2)),
        'blur1': normalize(blur1),
        'blur2': normalize(blur2)
    }


def convolve(img, kernel):
    """2D畳み込み"""
    h, w = img.shape
    kh, kw = kernel.shape
    pad_h, pad_w = kh // 2, kw // 2

    # ゼロパディング
    padded = np.pad(img, ((pad_h, pad_h), (pad_w, pad_w)), mode='edge')

    result = np.zeros_like(img)
    for i in range(h):
        for j in range(w):
            result[i, j] = np.sum(padded[i:i+kh, j:j+kw] * kernel)

    return result


def gaussian_blur(img, sigma):
    """ガウシアンぼかし"""
    size = int(6 * sigma + 1)
    if size % 2 == 0:
        size += 1

    x = np.arange(size) - size // 2
    kernel_1d = np.exp(-x**2 / (2 * sigma**2))
    kernel_1d /= kernel_1d.sum()

    # 分離可能カーネルとして適用
    kernel_2d = np.outer(kernel_1d, kernel_1d)

    return convolve(img, kernel_2d)


def non_max_suppression(magnitude, direction):
    """Non-maximum suppression"""
    h, w = magnitude.shape
    result = np.zeros_like(magnitude)

    # 方向を0, 45, 90, 135度に量子化
    angle = direction * 180 / np.pi
    angle[angle < 0] += 180

    for i in range(1, h-1):
        for j in range(1, w-1):
            q, r = 255, 255

            # 0度方向（水平エッジ）
            if (0 <= angle[i,j] < 22.5) or (157.5 <= angle[i,j] <= 180):
                q = magnitude[i, j+1]
                r = magnitude[i, j-1]
            # 45度方向
            elif 22.5 <= angle[i,j] < 67.5:
                q = magnitude[i+1, j-1]
                r = magnitude[i-1, j+1]
            # 90度方向（垂直エッジ）
            elif 67.5 <= angle[i,j] < 112.5:
                q = magnitude[i+1, j]
                r = magnitude[i-1, j]
            # 135度方向
            elif 112.5 <= angle[i,j] < 157.5:
                q = magnitude[i-1, j-1]
                r = magnitude[i+1, j+1]

            if magnitude[i,j] >= q and magnitude[i,j] >= r:
                result[i,j] = magnitude[i,j]

    return result


def hysteresis_threshold(img, low, high):
    """ヒステリシス閾値処理"""
    h, w = img.shape
    result = np.zeros_like(img, dtype=bool)

    strong = img >= high
    weak = (img >= low) & (img < high)

    result[strong] = True

    # 弱いエッジで強いエッジに接続しているものを追加
    changed = True
    while changed:
        changed = False
        for i in range(1, h-1):
            for j in range(1, w-1):
                if weak[i, j] and not result[i, j]:
                    if np.any(result[i-1:i+2, j-1:j+2]):
                        result[i, j] = True
                        changed = True

    return result


def normalize(img):
    """0-255に正規化"""
    min_val = img.min()
    max_val = img.max()
    if max_val - min_val == 0:
        return np.zeros_like(img)
    return ((img - min_val) / (max_val - min_val) * 255).astype(np.uint8)


def save_image(array, path):
    """配列を画像として保存"""
    if array.dtype != np.uint8:
        array = array.astype(np.uint8)
    Image.fromarray(array).save(path)
    print(f"保存: {path}")


def main():
    if len(sys.argv) < 2:
        print("Usage: python edge_detection_compare.py <image_path>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_dir = os.path.dirname(input_path)
    base_name = os.path.splitext(os.path.basename(input_path))[0]

    print(f"画像読み込み: {input_path}")
    img = load_image(input_path)
    print(f"サイズ: {img.shape}")

    # 元画像（グレースケール）も保存
    save_image(normalize(img), os.path.join(output_dir, f"{base_name}_gray.png"))

    # 1. Sobel
    print("\n=== Sobel ===")
    sobel = sobel_edge(img)
    save_image(sobel['x'], os.path.join(output_dir, f"{base_name}_sobel_x.png"))
    save_image(sobel['y'], os.path.join(output_dir, f"{base_name}_sobel_y.png"))
    save_image(sobel['magnitude'], os.path.join(output_dir, f"{base_name}_sobel_mag.png"))

    # 2. Canny
    print("\n=== Canny ===")
    canny = canny_edge(img)
    save_image(canny['blurred'], os.path.join(output_dir, f"{base_name}_canny_blur.png"))
    save_image(canny['nms'], os.path.join(output_dir, f"{base_name}_canny_nms.png"))
    save_image(canny['result'], os.path.join(output_dir, f"{base_name}_canny_result.png"))

    # 3. Laplacian
    print("\n=== Laplacian ===")
    lap = laplacian_edge(img)
    save_image(lap['4neighbor'], os.path.join(output_dir, f"{base_name}_laplacian_4.png"))
    save_image(lap['8neighbor'], os.path.join(output_dir, f"{base_name}_laplacian_8.png"))

    # 4. DoG
    print("\n=== DoG ===")
    dog = dog_edge(img)
    for name, result in dog.items():
        save_image(result, os.path.join(output_dir, f"{base_name}_dog_{name}.png"))

    print("\n完了！")


if __name__ == "__main__":
    main()
