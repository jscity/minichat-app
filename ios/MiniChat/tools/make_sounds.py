"""合成 Pip-Boy 风格的按键音效（原创合成，不含任何游戏素材）。

运行：python3 tools/make_sounds.py   →  写入 Sources/Sounds/*.wav（44.1 kHz / 16-bit / 单声道）
想换成自己的音效，保持同名替换 wav 文件即可。
"""
import math
import random
import struct
import wave
from pathlib import Path

RATE = 44100
OUT = Path(__file__).resolve().parent.parent / 'Sources' / 'Sounds'
random.seed(7)


def silence(ms):
    return [0.0] * int(RATE * ms / 1000)


def tick(gain=1.0):
    """继电器式的“咔哒”：一小段噪声 + 高频共振衰减 + 低频闷响。"""
    n = int(RATE * 0.045)
    out = []
    for i in range(n):
        t = i / RATE
        noise = (random.random() * 2 - 1) * math.exp(-t / 0.0012)
        ring = math.sin(2 * math.pi * 3150 * t) * math.exp(-t / 0.006) * 0.55
        body = math.sin(2 * math.pi * 145 * t) * math.exp(-t / 0.012) * 0.6
        out.append((noise * 0.7 + ring + body) * gain)
    return out


def blip(freq_from, freq_to, ms, gain=0.5, square=0.35):
    """终端提示音：带一点方波成分的扫频，指数衰减。"""
    n = int(RATE * ms / 1000)
    out, phase = [], 0.0
    for i in range(n):
        k = i / n
        freq = freq_from + (freq_to - freq_from) * k
        phase += 2 * math.pi * freq / RATE
        s = math.sin(phase)
        sq = 1.0 if s >= 0 else -1.0
        env = min(1.0, i / (RATE * 0.002)) * math.exp(-k * 3.2)
        out.append(((1 - square) * s + square * sq) * env * gain)
    return out


def buzz(freq, ms, gain=0.45):
    """错误提示：低频方波嗡声，带颤动。"""
    n = int(RATE * ms / 1000)
    out = []
    for i in range(n):
        t = i / RATE
        sq = 1.0 if math.sin(2 * math.pi * freq * t) >= 0 else -1.0
        trem = 0.75 + 0.25 * math.sin(2 * math.pi * 28 * t)
        env = min(1.0, i / (RATE * 0.003)) * min(1.0, (n - i) / (RATE * 0.02))
        out.append(sq * trem * env * gain)
    return out


def mix(*parts):
    """parts: (offset_ms, samples)"""
    length = max(int(RATE * off / 1000) + len(sm) for off, sm in parts)
    out = [0.0] * length
    for off, sm in parts:
        start = int(RATE * off / 1000)
        for i, v in enumerate(sm):
            out[start + i] += v
    return out


def crunch(samples, bits=10, drive=1.6):
    """一点点位深压缩和软削波，听起来更像老式扬声器。"""
    step = 2 ** (bits - 1)
    return [round(math.tanh(v * drive) * step) / step for v in samples]


def lowpass(samples, cutoff=6500):
    rc = 1 / (2 * math.pi * cutoff)
    a = (1 / RATE) / (rc + 1 / RATE)
    out, prev = [], 0.0
    for v in samples:
        prev += a * (v - prev)
        out.append(prev)
    return out


def write(name, samples, peak=0.5):
    samples = lowpass(crunch(samples)) + silence(10)
    top = max(abs(v) for v in samples) or 1
    frames = b''.join(struct.pack('<h', int(v / top * peak * 32767)) for v in samples)
    OUT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT / f'{name}.wav'), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(frames)
    print(f'{name}.wav  {len(samples) / RATE * 1000:.0f} ms')


write('key', tick(), peak=0.55)
write('mic_on', mix((0, tick(0.7)), (6, blip(620, 1450, 85, square=0.25))), peak=0.55)
write('mic_off', mix((0, blip(1450, 620, 85, square=0.25)), (80, tick(0.6))), peak=0.5)
# 发送：上扬的两段提示音
write('send', mix((0, tick(0.6)), (6, blip(990, 1320, 45, square=0.2)), (50, blip(1480, 1560, 60, square=0.2))), peak=0.5)
# 回复逐字出现时的终端打字声，很轻
write('type', tick(0.5), peak=0.16)
# 回复完成：短促一声
write('done', mix((0, blip(1320, 1320, 35, square=0.2)), (40, blip(1760, 1760, 45, square=0.2))), peak=0.32)
write('success', mix((0, tick(0.7)), (6, blip(880, 880, 50)), (58, blip(1175, 1175, 50)), (110, blip(1568, 1568, 80))), peak=0.6)
write('error', mix((0, tick(0.8)), (6, buzz(155, 150))), peak=0.5)
