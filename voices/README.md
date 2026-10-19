# Piper voices for local AI TTS

Copy these from the standalone Piper repo (`Piper/voices/`):

- `en_GB-cori-medium.onnx` + `en_GB-cori-medium.onnx.json` (the voice model)
- `custom_words.json` (place-name pronunciations, e.g. Uttoxeter)
- `directed_replaces.json` (plain fixes, e.g. Xpress → express)

The portal's `GET /api/tts/voices` lists whatever `.onnx` files are here.

The `piper` engine itself is not installed on this laptop — install it
where announcements run (the bus Pi):

```bash
sudo apt install espeak-ng
pip install piper-tts
```

Without both, the next-stop page keeps using browser TTS and
`POST /api/tts` reports what is missing.
