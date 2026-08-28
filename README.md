# GIF Lab

Two tools on one page, both running entirely on your own computer. Nothing is
uploaded anywhere, there is no account, and once it is installed it works with
the internet switched off.

**GIF Lab** makes animated GIFs — stickers, emoji, reaction gifs — out of a video
or a pile of images.

**Cutout** takes a still picture, removes the background, and lets you fix what
the model got wrong by painting the transparency with your finger.

It is good at the awkward parts:

- **Transparency that actually stays transparent.** Most tools quietly flatten
  it, or leave a ghost of the previous frame showing through. This one doesn't.
- **Pictures that are not all the same size.** Drop in nine images from nine
  different places and it fits them onto one canvas, centered, with transparent
  space around the smaller ones, instead of stretching them.
- **Getting under a size limit.** Discord stickers and emoji have one; so do
  most forums. The size is shown after every build, and there is a whole panel
  for getting it down.
- **When the model misses an arm.** Paint the transparency back by hand, with a
  magnifier that gets out from under your finger.

---

## What you need first

Three things. All free.

**1. Node.js, version 20 or newer.** — <https://nodejs.org> (the "LTS" download).

**2 and 3. ffmpeg and gifsicle.** These are the two programs that do the actual
picture work. GIF Lab is the controls for them.

| Your computer | Type this |
|---|---|
| macOS | `brew install ffmpeg gifsicle` |
| Ubuntu / Debian | `sudo apt install ffmpeg gifsicle` |
| Fedora | `sudo dnf install ffmpeg gifsicle` |
| Windows | `winget install Gyan.FFmpeg` then `winget install gifsicle` |

On Windows, **close your terminal and open a new one** after installing. A
program that was just added to your PATH is invisible to a window that was
already open, and this trips up nearly everyone.

---

## Install and run

```
git clone https://github.com/match-stik/the-gif-lab.git
cd the-gif-lab
npm install
npm start
```

Then open **<http://localhost:8080>** in a browser.

`npm start` builds the page if it needs building and then serves it, so there is
no separate build step to remember. To check your setup without starting the
server, run `npm run check`.

To stop it, press `Ctrl+C` in the terminal.

### Installing it as an app

Once it is open in a browser it can go on a home screen and open in its own
window, with no browser chrome round it. The server still has to be running
somewhere — the page is the controls, your computer does the work.

**On the machine that is running it,** this already works. Open
<http://localhost:8080>, and Chrome or Edge will show an install button in the
address bar; on Safari it is Share → Add to Home Screen.

**On your phone, or any other device, it needs HTTPS.** That is not this tool
being fussy — browsers only allow the service worker an installed app needs on a
secure origin, and a secure origin means `localhost` or `https://`. Plain
`http://192.168.1.20:8080` will load and work perfectly well in a browser tab.
It will simply never offer to install.

So if you want it on a phone, put it behind something that gives you a
certificate. Three ways, easiest first.

**Tailscale.** If the machine is already on your tailnet, this is one line and
there is no port to open, no domain to buy, and nothing exposed to the internet:

```
tailscale serve --bg 8080
```

It answers on `https://<machine>.<your-tailnet>.ts.net`, and that is a real
certificate, so your phone will offer to install it. If that address is already
serving something else, give this one a path of its own:

```
tailscale serve --bg --set-path /giflab 8080
```

`tailscale serve status` shows what is running, and `tailscale serve --bg off`
stops it.

**Caddy,** if you already have a domain pointed at the machine. Two lines in a
Caddyfile and it fetches the certificate itself:

```
giflab.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

**Any reverse proxy you already run** — nginx, Traefik, whatever is in front of
your other things. Point it at `127.0.0.1:8080`. There is nothing special about
this app: it is a plain HTTP server on one port.

**What about `--host 0.0.0.0`?** That makes it reachable from other devices on
your network without any of the above, and it is the honest answer for "I just
want it on my phone for ten minutes". Two things to know. It will not offer to
install, for the reason above. And **there is no password on it** — anyone who
can reach that address can use it, and every job it runs starts a program on
your machine. Only on a network you trust.


---

## Using GIF Lab

**1. Bring pictures in.** Either import a video or an existing GIF, which gets
chopped into frames, or add a batch of still images. You can do both, and add
more later.

**2. Choose which frames go in.** Tap a picture to look at it. Tap its circle to
include or exclude it. Dimmed pictures are left out.

**3. Crop Frames** — optional. The **All frames / This frame only** switch
matters more than it looks. *All frames* gives every picture the same box, which
is what you want for frames out of a video. *This frame only* cuts the one you
are looking at, which is what you want for hand-picked images.

**4. Background Removal** — optional. *Color* keys out one flat color and needs
nothing installed. *AI* finds the subject and cuts everything else away, and
needs the setup further down.

**5. Output Size.** Presets, or type your own numbers. Leave both boxes empty to
keep the pictures at whatever size they already are.

**6. Add Text** — optional. Drag it around the preview to place it. Where you put
it is where it lands, at any output size. The typefaces on offer are the ones
installed on this computer — see [Fonts](#fonts) if the list looks short.

**7. Create GIF.** The finished file appears at the bottom with its size, and a
Download GIF button.

---

## Using Cutout

Bring in one picture. **Find subject** runs the model; **By color** keys out a
flat backdrop and needs nothing installed. **Pick from image** samples the color
you want gone.

When the model misses something — an arm against a dark room, a strand of hair —
press **Paint** and fix it by hand. Restore what it cut, erase what it kept, undo
a stroke at a time. A magnifier follows your finger so you can see what you are
painting.

**Save as** an Emoji (128 px, under 256 KB), a Sticker (320×320, under 512 KB),
or full size untouched, as PNG or WebP. The size budget is honored by fitting
the dimensions first and only reducing colors if the file is genuinely over.

---

## Three things that surprise people

**The canvas can be bigger than any of your pictures.** If one picture is wide
and another is tall, the shared canvas is as wide as the widest and as tall as
the tallest — so both fit without being squashed. That is arithmetic, not a
fault. The spare space is transparent, and transparent space costs almost
nothing in a GIF.

**Cropping one frame tighter does not make the GIF smaller.** The canvas is still
the biggest picture in the set; the frame you cropped just gains more empty space
around it. If you want the whole thing smaller, crop the *biggest* picture.

**"Preserve Color" is a starting point, not a lock.** Turning it on fills in a set
of settings that suit a full-color transparent sticker. After that every control
is yours again — change anything and it stays changed.

---

## Fonts

The caption is drawn by ffmpeg, which uses the fonts installed on **this**
computer — not the ones your browser has. A bare Linux server usually has about
three.

On Linux the list is read with `fc-list`, part of **fontconfig**. If that is not
installed the picker falls back to a handful of names and stays there no matter
what you add:

```
sudo apt install fontconfig
```

Then add as many families as you like — every one shows up in the picker:

```
sudo apt install fonts-liberation2 fonts-dejavu-extra fonts-ubuntu \
  fonts-roboto-unhinted fonts-open-sans fonts-lato fonts-comic-neue \
  fonts-cabin fonts-quicksand fonts-inter fonts-firacode fonts-bebas-neue \
  fonts-jetbrains-mono fonts-montserrat fonts-nunito fonts-noto-color-emoji
```

On macOS and Windows there is nothing to do.

---

## Background removal, and painting by hand

Both need Python and a model file, which is a bigger ask than the rest, so they
are off unless you set them up. Everything else works without them, and the
*Color* option removes a flat background with nothing installed at all.

```
python3 -m venv .venv
.venv/bin/pip install onnxruntime numpy pillow
curl -L -o u2net.onnx \
  https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx
```

The model file is about 176 MB, so that last line is the slow part.

**On Debian and Ubuntu the first line usually fails**, with a message about
`ensurepip` not being available. Python is installed; the piece that builds
virtual environments is packaged separately. Either install it —
`sudo apt install python3-venv` — or skip it and use
[uv](https://docs.astral.sh/uv/), which needs no root:

```
uv venv .venv
uv pip install --python .venv/bin/python onnxruntime numpy pillow
```

Then start it with both paths set:

```
GIFLAB_PYTHON="$PWD/.venv/bin/python" GIFLAB_MODEL="$PWD/u2net.onnx" npm start
```

On Windows the Python inside the virtual environment is at
`.venv\Scripts\python.exe`.

`u2net` is fast and sees one main subject. `isnet` models are slower and keep
everyone in a group photo. You can run both at once and combine them with
`GIFLAB_ALSO_MODELS=/path/to/second.onnx` — one loses a second person, the other
loses low-contrast clothing, and together they catch more than either alone.

---

## Settings

| Option | What it does |
|---|---|
| `npm start -- --port 8081` | Serve on a different port |
| `npm start -- --host 0.0.0.0` | Also reachable from other devices on your network. **There is no password** — only on a network you trust. |
| `GIFLAB_PYTHON` | Interpreter for background removal and hand painting |
| `GIFLAB_MODEL` | The `.onnx` model file |
| `GIFLAB_ALSO_MODELS` | A second model, combined with the first |

Working files go in `data/gif-work` and are cleared out as sessions age.

---

## Where this came from

The two tools are lifted, as they are, out of a private app they were written
for and used in daily. That is deliberate: an earlier attempt at this
repo reimplemented them from a reading of the originals, and drifted — different
words, a different shape, a different feel. These are the originals, with four
small files standing where that app used to be (a fetch wrapper, a color
set, a config reader and a filename sanitiser).

---

## License

Apache 2.0. See [LICENSE](LICENSE).
