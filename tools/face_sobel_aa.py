#!/usr/bin/env python3
"""顔部分を元画像から切り出し、Sobel binary 30処理してAA生成"""
import numpy as np
from PIL import Image
from scipy import ndimage

# 元画像から顔部分を切り出し
img = Image.open('docs/images/kirinuki_indo.png').convert('L')
print(f"元画像サイズ: {img.size}")

# 顔部分（元画像1024x1024での座標）
face = img.crop((350, 120, 550, 350))
print(f"顔部分サイズ: {face.size}")
face.save('docs/images/kirinuki_indo_face_original.png')

# Sobel処理
face_arr = np.array(face, dtype=float)

# Sobelカーネル
sobel_x = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]])
sobel_y = np.array([[-1, -2, -1], [0, 0, 0], [1, 2, 1]])

gx = ndimage.convolve(face_arr, sobel_x)
gy = ndimage.convolve(face_arr, sobel_y)
magnitude = np.sqrt(gx**2 + gy**2)

# 正規化
magnitude = (magnitude / magnitude.max() * 255).astype(np.uint8)

# Binary threshold 30
binary = (magnitude >= 30).astype(np.uint8) * 255
Image.fromarray(binary).save('docs/images/kirinuki_indo_face_sobel_binary_30.png')
print("Sobel binary 30 処理完了")
