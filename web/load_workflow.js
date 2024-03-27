import { app } from "../../scripts/app.js";

// This is a copy of the function from ComfyUI (pnginfo.js). Cannot use the
// original since it isn’t exported.
function parseExifData(exifData) {
  // Check for the correct TIFF header (0x4949 for little-endian or 0x4D4D for big-endian)
  const isLittleEndian = new Uint16Array(exifData.slice(0, 2))[0] === 0x4949;

  // Function to read 16-bit and 32-bit integers from binary data
  function readInt(offset, isLittleEndian, length) {
    let arr = exifData.slice(offset, offset + length)
    if (length === 2) {
      return new DataView(arr.buffer, arr.byteOffset, arr.byteLength).getUint16(0, isLittleEndian);
    } else if (length === 4) {
      return new DataView(arr.buffer, arr.byteOffset, arr.byteLength).getUint32(0, isLittleEndian);
    }
  }

  // Read the offset to the first IFD (Image File Directory)
  const ifdOffset = readInt(4, isLittleEndian, 4);

  function parseIFD(offset) {
    const numEntries = readInt(offset, isLittleEndian, 2);
    const result = {};

    for (let i = 0; i < numEntries; i++) {
      const entryOffset = offset + 2 + i * 12;
      const tag = readInt(entryOffset, isLittleEndian, 2);
      const type = readInt(entryOffset + 2, isLittleEndian, 2);
      const numValues = readInt(entryOffset + 4, isLittleEndian, 4);
      const valueOffset = readInt(entryOffset + 8, isLittleEndian, 4);

      // Read the value(s) based on the data type
      let value;
      if (type === 2) {
        // ASCII string
        value = String.fromCharCode(...exifData.slice(valueOffset, valueOffset + numValues - 1));
      }

      result[tag] = value;
    }

    return result;
  }

  // Parse the first IFD
  const ifdData = parseIFD(ifdOffset);
  return ifdData;
}

function readFile(file)
{
  return new Promise(resolve =>
  {
    const reader = new FileReader();
    reader.onload = event => {
      resolve(new DataView(event.target.result));
    };
    reader.readAsArrayBuffer(file);
  });
}

function extractMetadataFromExif(array)
{
  const data = parseExifData(array);

  // Look for the UserComment EXIF tag
  let userComment = data[0x9286];
  if (userComment)
  {
    try {
      return JSON.parse(userComment);
    } catch (e) {
      // Ignore non-JSON contents
    }
  }

  return null;
}

async function getWebpMetadata(file)
{
  const dataView = await readFile(file);

  // Check WEBP signature
  if (dataView.getUint32(0) !== 0x52494646 || dataView.getUint32(8) !== 0x57454250)
    return null;

  // Go through the chunks
  let offset = 12;
  while (offset < dataView.byteLength)
  {
    const chunkType = dataView.getUint32(offset);
    const chunkLength = dataView.getUint32(offset + 4, true);
    if (chunkType == 0x45584946)  // EXIF
    {
      const data = extractMetadataFromExif(new Uint8Array(dataView.buffer, offset + 8, chunkLength));
      if (data)
        return data;
    }
    offset += 8 + chunkLength;
  }

  return null;
}

async function getJpegMetadata(file)
{
  const dataView = await readFile(file);

  // Check that the JPEG SOI segment is present
  if (dataView.getUint16(0) !== 0xFFD8)
    return null;

  // Go through other segments
  let offset = 2;
  while (offset < dataView.byteLength)
  {
    const segmentType = dataView.getUint16(offset);
    if (segmentType == 0xFFD9 || (segmentType & 0xFF00) != 0xFF00)
    {
      // EOI segment or invalid segment type
      break;
    }

    const segmentLength = dataView.getUint16(offset + 2);
    if (segmentLength < 2)
    {
      // Invalid segment length
      break;
    }

    if (segmentType == 0xFFE1 && segmentLength > 8)
    {
      // APP1 segment contains EXIF data
      // Skip next six bytes ("Exif\0\0"), not part of EXIF data
      const data = extractMetadataFromExif(new Uint8Array(dataView.buffer, offset + 10, segmentLength - 8));
      if (data)
        return data;
    }
    offset += 2 + segmentLength;
  }

  return null;
}

function getMetadata(file)
{
  if (file.type === "image/webp")
    return getWebpMetadata(file);
  else if (file.type == "image/jpeg")
    return getJpegMetadata(file);
  else
    return null;
}

async function handleFile(origHandleFile, file, ...args)
{
  const metadata = await getMetadata(file);
  if (metadata && metadata.workflow)
    app.loadGraphData(metadata.workflow);
  else if (metadata && metadata.prompt)
    app.loadApiJson(metadata.prompt);
  else
    return origHandleFile.call(this, file, ...args);
}

const ext = {
  name: "SaveImageExtended",
  async setup()
  {
    // It would be better to register our own handler for the drop event but there
    // is no way to consider nodes handling the event. So piggybacking it is.
    let origHandleFile = app.handleFile;
    app.handleFile = function(...args)
    {
      handleFile.call(this, origHandleFile, ...args)
    };

    // Make sure workflow upload accepts WEBP and JPEG files
    const input = document.getElementById("comfy-file-input");
    let types = input?.getAttribute("accept");
    if (types)
    {
      types = types.split(",").map(t => t.trim());
      if (!types.includes("image/webp"))
        types.push("image/webp");
      if (!types.includes("image/jpeg"))
        types.push("image/jpeg");
      input.setAttribute("accept", types.join(","));
    }
  },
};

app.registerExtension(ext);
