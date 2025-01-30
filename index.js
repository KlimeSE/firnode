const fs = require('fs/promises');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const tf = require('@tensorflow/tfjs-node');
const { program } = require('commander');


class UnableToParseQuantity extends Error { }


async function process(screenshotCanvas, iconModelURL, iconClassNames, quantityModelURL, quantityClassNames) {
    models[iconModelURL] ||= tf.loadGraphModel('file://' + iconModelURL);
    models[quantityModelURL] ||= tf.loadGraphModel('file://' + quantityModelURL);

    const stockpile = extractStockpile(screenshotCanvas);
    if (!stockpile) {
        return undefined;
    }

    // First do the cropping
    stockpile.box.canvas = cropCanvas(screenshotCanvas, stockpile.box);
    stockpile.contents = await extractContents(stockpile.box.canvas, models[iconModelURL], iconClassNames, models[quantityModelURL], quantityClassNames);

    // stockpile.header = {};

    // if (stockpile.contents && stockpile.contents.length) {
    //     const existingTop = stockpile.box.y;
    //     const headerHeight = stockpile.contents[0].quantityBox.height;
    //     stockpile.box.y = Math.max(existingTop - headerHeight, 0);

    //     const topOffset = existingTop - stockpile.box.y
    //     stockpile.box.height += topOffset;

    //     for (const element of stockpile.contents) {
    //         element.iconBox.y += topOffset;
    //         element.quantityBox.y += topOffset;
    //     }

    //     stockpile.box.canvas = cropCanvas(screenshotCanvas, stockpile.box);

    //     if (topOffset > headerHeight * 9 / 10) {
    //         stockpile.header = await extractHeader(stockpile.box.canvas, topOffset, stockpile.contents[0].quantityBox.width);
    //     } else {
    //         console.log('Unable to parse header (too small).');
    //     }
    // }

    return stockpile;
}

async function extractContents(canvas, iconModel, iconClassNames, quantityModel, quantityClassNames) {
    // These tune the cropping of inventory items
    const MIN_QUANTITY_WIDTH = 30;
    const MAX_QUANTITY_WIDTH = 90;

    const MIN_QUANTITY_HEIGHT = 22;
    const MAX_QUANTITY_HEIGHT = 70;

    const MAX_GREY_CHROMA = 16;
    const MAX_GREY_LIGHTNESS_VARIANCE = 16;

    const width = canvas.width;
    const height = canvas.height;

    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    const pixels = context.getImageData(0, 0, width, height).data;

    // Find the most common grey which is probably the quantity background
    const MIN_GREY = 32;
    const MAX_GREY = 224;
    const greys = {};
    for (let offset = 0; offset < pixels.length; offset += 4) {
        const value = Math.round(getCL(pixels[offset], pixels[offset + 1], pixels[offset + 2]).lightness);
        if ((value >= MIN_GREY) && (value <= MAX_GREY)) {
            greys[value] = (greys[value] || 0) + 1;
        }
    }
    const QUANTITY_GREY_VALUE = Object.keys(greys).sort((a, b) => greys[b] - greys[a])[0];

    const contents = [];
    const promises = [];

    for (let row = 0; row < height; ++row) {
        let greyCount = 0;
        let quantityBottom = null;
        let quantityBottomVerified = false;

        for (let col = 0; col < width; ++col) {
            // Opportunity: If > N of same pixel counted, skip to next line
            const redIndex = calcRedIndex(row, col, width);
            if (isGrey(pixels[redIndex], pixels[redIndex + 1], pixels[redIndex + 2])) {
                ++greyCount;
            } else if ((greyCount >= MIN_QUANTITY_WIDTH) && (greyCount <= MAX_QUANTITY_WIDTH)) {
                const quantityBox = {
                    x: col - greyCount,
                    y: row,
                    width: greyCount,
                };
                let quantityGap;

                if (!quantityBottom || !quantityBottomVerified) {
                    quantityBottom = findQtyBottom(pixels, quantityBox.y, quantityBox.x, width, height);
                    quantityGap = quantityBox.x;
                } else {
                    const previous = contents[contents.length - 1].quantityBox;
                    quantityGap = quantityBox.x - (previous.x + previous.width);
                }
                quantityBox.height = quantityBottom - quantityBox.y + 1;
                //console.log(quantityBox);

                if ((quantityBox.height >= MIN_QUANTITY_HEIGHT) && (quantityBox.height <= MAX_QUANTITY_HEIGHT)) {
                    // Found an item quantity
                    quantityBottomVerified = true;

                    const element = {
                        quantityBox,
                    };
                    //element.quantityBox.canvas = cropCanvas(canvas, quantityBox, 'grayscale(100%) invert(100%)', 5);

                    //promises.push(ocrQuantity(canvas, quantityBox, (265 - QUANTITY_GREY_VALUE) * 2/3).then(q => element.quantity = q).catch(function(e) {
                    promises.push(ocrQuantity(canvas, quantityBox, quantityModel, quantityClassNames, (265 - QUANTITY_GREY_VALUE) * 2 / 3).then(q => element.quantity = q).catch(function (e) {
                        if (e instanceof UnableToParseQuantity) {
                            console.log('Unable to parse quantity:', quantityBox);
                        } else {
                            throw e;
                        }
                    }));

                    const iconWidth = quantityBox.height;
                    const iconGap = Math.ceil((quantityGap - iconWidth) / 2);
                    element.iconBox = {
                        x: quantityBox.x - iconGap - iconWidth,
                        y: quantityBox.y,
                        width: iconWidth,
                        height: iconWidth,
                    };
                    element.iconBox.canvas = cropCanvas(canvas, element.iconBox);

                    promises.push(classifyIcon(element.iconBox.canvas, iconModel, iconClassNames).then(o => Object.assign(element, o)));

                    contents.push(element);
                }

                greyCount = 0;
            } else {
                greyCount = 0;
            }
        }

        //console.log(contents.length, quantityBottom);
        if (quantityBottom) {
            row = quantityBottom;
        }
    }

    await Promise.all(promises);

    return contents;

    function findQtyBottom(pixels, row, col, width, height) {
        for (var checkRow = row + 1; checkRow <= height; ++checkRow) {
            const redIndex = calcRedIndex(checkRow, col, width);
            if (!isGrey(pixels[redIndex], pixels[redIndex + 1], pixels[redIndex + 2])) {
                break;
            }
        }
        return checkRow - 1;
    }

    function isGrey(r, g, b) {
        return checkPixel(r, g, b, MAX_GREY_CHROMA, QUANTITY_GREY_VALUE, MAX_GREY_LIGHTNESS_VARIANCE);
    }
}

let num = 0;

async function ocrQuantity(canvas, box, model, classNames, threshold) {
    canvas = cropCanvas(canvas, box, 'grayscale(100%) invert(100%)', 5);
    thresholdCanvas(canvas, threshold);

    canvas = autoCropCanvas(canvas, 32, 32);

    const tfImage = tf.browser.fromPixels(canvas, 1).toFloat();
    const prediction = (await model).predict(tfImage.expandDims(0));

    const best = (await prediction.argMax(1).data())[0];
    let value = classNames[best];

    if (value.match(/^[1-9][0-9]*k\+$/)) {
        value = parseInt(value.slice(0, -2), 10) * 1000;
    } else if (value.match(/^[0-9]+x$/)) {
        value = parseInt(value.slice(0, -1), 10);
    } else if (value.match(/^([1-9][0-9]*|[0-9])$/)) {
        value = parseInt(value, 10);
    } else {
        throw new UnableToParseQuantity(value);
    }

    return value;
}

async function classifyIcon(canvas, model, classNames) {
    const tfImage = tf.image.resizeBilinear(tf.browser.fromPixels(canvas), [32, 32]);
    const prediction = (await model).predict(tfImage.expandDims(0));

    const best = (await prediction.argMax(1).data())[0];
    const key = classNames[best];

    return {
        CodeName: key.replace(CRATED_REGEXP, ''),
        isCrated: !!key.match(CRATED_REGEXP),
    };
}


function thresholdCanvas(canvas, threshold) {
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const length = imageData.data.length;

    for (let offset = 0; offset < length; offset += 4) {
        const value = !(imageData.data[offset] <= threshold) * 255;

        imageData.data[offset] = value;
        imageData.data[offset + 1] = value;
        imageData.data[offset + 2] = value;
    }
    context.putImageData(imageData, 0, 0);
}

function autoCropCanvas(image, outputWidth, outputHeight) {
    const MIN_VALUE_CROP = 128;

    const imageWidth = image.width;
    const imageHeight = image.height;

    let top = 0;
    let right = imageWidth - 1;
    let bottom = imageHeight - 1;
    let left = 0;

    const imgContext = image.getContext('2d', { alpha: false, willReadFrequently: true });
    const imgPixels = imgContext.getImageData(0, 0, imageWidth, imageHeight).data;

    for (let offset = 0; offset < imgPixels.length; offset += 4) {
        if ((imgPixels[offset] < MIN_VALUE_CROP) ||
            (imgPixels[offset + 1] < MIN_VALUE_CROP) ||
            (imgPixels[offset + 2] < MIN_VALUE_CROP)) {
            top = Math.floor((offset - 4) / 4 / imageWidth);
            break;
        }
    }

    right:
    for (let col = imageWidth - 1; col >= 0; --col) {
        for (let row = 0; row <= imageHeight; ++row) {
            const offset = (row * imageWidth + col) * 4;
            if ((imgPixels[offset] < MIN_VALUE_CROP) ||
                (imgPixels[offset + 1] < MIN_VALUE_CROP) ||
                (imgPixels[offset + 2] < MIN_VALUE_CROP)) {
                right = col;
                break right;
            }
        }
    }

    for (let offset = imgPixels.length - 4; offset >= 0; offset -= 4) {
        if ((imgPixels[offset] < MIN_VALUE_CROP) ||
            (imgPixels[offset + 1] < MIN_VALUE_CROP) ||
            (imgPixels[offset + 2] < MIN_VALUE_CROP)) {
            bottom = Math.floor((offset + 4) / 4 / imageWidth);
            break;
        }
    }

    left:
    for (let col = 0; col < imageWidth; ++col) {
        for (let row = 0; row < imageHeight; ++row) {
            const offset = (row * imageWidth + col) * 4;
            if ((imgPixels[offset] < MIN_VALUE_CROP) ||
                (imgPixels[offset + 1] < MIN_VALUE_CROP) ||
                (imgPixels[offset + 2] < MIN_VALUE_CROP)) {
                left = col;
                break left;
            }
        }
    }

    const cropWidth = right - left + 1;
    const cropHeight = bottom - top + 1;

    const canvas = createCanvas(outputWidth, outputHeight);
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });

    context.drawImage(image,
        left, top, cropWidth, cropHeight,
        0, 0, outputWidth, outputHeight);

    return canvas;
}

function cropCanvas(input, box, filter, resize) {
    if (!filter) filter = 'none';
    if (!resize) resize = 1;

    const outputWidth = Math.round(box.width * resize);
    const outputHeight = Math.round(box.height * resize);

    const { createCanvas } = require('canvas');
    const output = createCanvas(outputWidth, outputHeight);
    const outputContext = output.getContext('2d', { alpha: false, willReadFrequently: true });

    // Draw the image first
    outputContext.drawImage(input,
        box.x, box.y, box.width, box.height,
        0, 0, outputWidth, outputHeight);

    // Apply filters manually
    if (filter.includes('grayscale') || filter.includes('invert')) {
        const imageData = outputContext.getImageData(0, 0, outputWidth, outputHeight);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
            // Convert to grayscale first
            if (filter.includes('grayscale')) {
                const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
                data[i] = avg;     // R
                data[i + 1] = avg; // G
                data[i + 2] = avg; // B
            }

            // Then invert if needed
            if (filter.includes('invert')) {
                data[i] = 255 - data[i];         // R
                data[i + 1] = 255 - data[i + 1]; // G
                data[i + 2] = 255 - data[i + 2]; // B
            }
        }

        outputContext.putImageData(imageData, 0, 0);
    }

    return output;
}

function extractStockpile(canvas) {
    const MIN_INVENTORY_WIDTH = 100;
    const MIN_INVENTORY_HEIGHT = 25;

    const MAX_DARK_CHANNEL_CHROMA = 24;
    const MAX_DARK_PIXEL_LIGHTNESS = 32;

    const MAX_MERGE_VARIANCE = 3;
    const MIN_DARK_EDGE_PERCENT = 0.8;

    const width = canvas.width;
    const height = canvas.height;

    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    const pixels = context.getImageData(0, 0, width, height).data;
    let darkStripes = {};

    for (let row = 0; row < height; ++row) {
        let darkCount = 0;
        for (let col = 0; col < width; ++col) {
            const redIndex = calcRedIndex(row, col, width);
            if (isDark(pixels, redIndex) && (col + 1 != width)) {
                ++darkCount;
            } else if (darkCount >= MIN_INVENTORY_WIDTH) {
                darkCount += col + 1 == width ? 1 : 0;
                let left = col - darkCount;
                darkStripes[left] = darkStripes[left] || [];
                darkStripes[left].push({
                    row: row,
                    right: col - 1,
                    left: left,
                });

                darkCount = 0;
            } else {
                darkCount = 0;
            }
        }
    }

    let boxes = [];
    for (let left of Object.keys(darkStripes)) {
        // parseInt since keys are strings
        left = parseInt(left, 10);
        let stripes = [];
        for (let leftOffset = left - MAX_MERGE_VARIANCE + 1; leftOffset < left + MAX_MERGE_VARIANCE; ++leftOffset) {
            stripes = stripes.concat(darkStripes[leftOffset] || []);
        }

        let rights = {};
        for (const stripe of stripes) {
            rights[stripe.right] ||= 0
            rights[stripe.right] += 1;
        }
        // keys are strings
        let mostRight = parseInt(Object.keys(rights).sort((a, b) => rights[b] - rights[a])[0], 10);

        let top = Number.MAX_SAFE_INTEGER;
        let bottom = 0;
        let stripesCount = 0;
        for (const stripe of stripes) {
            if ((stripe.right > mostRight - MAX_MERGE_VARIANCE) ||
                (stripe.right < mostRight + MAX_MERGE_VARIANCE)) {
                if (stripe.row < top) top = stripe.row;
                if (stripe.row > bottom) bottom = stripe.row;

                ++stripesCount;
            }
        }

        boxes.push({
            top: top,
            right: mostRight,
            bottom: bottom,
            left: left,
            darkStripes: stripesCount,
        });
    }
    //console.log(JSON.parse(JSON.stringify(boxes)));

    if (!boxes.length) {
        return undefined;
    }

    for (const outer of boxes) {
        for (const inner of boxes) {
            if ((outer === inner)
                || (inner.left > outer.left)
                || (inner.right < outer.right)) {
                continue;
            }

            if (inner.top < outer.top) {
                const trial = {};
                Object.assign(trial, outer);
                trial.top = inner.top;

                if (fitDarkSides(width, trial)) {
                    //console.log(inner, outer, trial);
                    Object.assign(outer, trial);
                }
            }
        }
    }
    //console.log(JSON.parse(JSON.stringify(boxes)));

    boxes.sort((a, b) => (b.right - b.left + 1) * (b.bottom - b.top + 1) - (a.right - a.left + 1) * (a.bottom - a.top + 1));

    // Merge overlapping boxes
    let primaryOffset = 0;
    while (primaryOffset < boxes.length - 1) {
        let primary = boxes[primaryOffset];
        let innerOffset = primaryOffset + 1;
        while (innerOffset < boxes.length) {
            let inner = boxes[innerOffset];
            if ((primary.top - MAX_MERGE_VARIANCE <= inner.top) &&
                (primary.right + MAX_MERGE_VARIANCE >= inner.right) &&
                (primary.bottom + MAX_MERGE_VARIANCE >= inner.bottom) &&
                (primary.left - MAX_MERGE_VARIANCE <= inner.left)) {
                primary.darkStripes += inner.darkStripes;
                boxes.splice(innerOffset, 1);
            } else {
                ++innerOffset;
            }
        }
        ++primaryOffset;
    }
    boxes = boxes.filter(b => b.bottom - b.top >= MIN_INVENTORY_HEIGHT);
    //console.log(JSON.parse(JSON.stringify(boxes)));

    //check left and right sides are mostly dark
    boxes = boxes.filter(fitDarkSides.bind(null, width));
    //console.log(JSON.parse(JSON.stringify(boxes)));

    // Prefer the box closest to the middle
    const middle = Math.round(width / 2);
    boxes.sort((a, b) => Math.abs(a.left - middle) - Math.abs(b.left - middle));
    const box = boxes[0];

    // Prefer the box with the most dark stripes by volume
    //boxes.sort((a, b) => (b.darkStripes / (b.bottom - b.top)) - (a.darkStripes / (a.bottom - a.top)));
    //const box = boxes[0];

    if (!box) {
        return undefined;
    }

    return {
        box: {
            x: box.left,
            y: box.top,
            width: box.right - box.left + 1,
            height: box.bottom - box.top + 1,
        }
    };

    function isDark(pixels, offset) {
        return checkPixel(
            pixels[offset], pixels[offset + 1], pixels[offset + 2],
            MAX_DARK_CHANNEL_CHROMA, 0, MAX_DARK_PIXEL_LIGHTNESS);
    }

    function fitDarkSides(width, box) {
        const darkLeft = {};
        const darkRight = {};
        for (let row = box.top; row <= box.bottom; ++row) {
            for (let offset = -MAX_MERGE_VARIANCE; offset < MAX_MERGE_VARIANCE; ++offset) {
                const left = box.left + offset;
                const right = box.right + offset;

                if (left >= 0) {
                    darkLeft[left] = (darkLeft[left] || 0) + (isDark(pixels, calcRedIndex(row, left, width)) ? 1 : 0);
                }

                if (right < width) {
                    darkRight[right] = (darkRight[right] || 0) + (isDark(pixels, calcRedIndex(row, right, width)) ? 1 : 0);
                }
            }
        }
        const height = box.bottom - box.top + 1;

        box.left = null;
        for (const [left, count] of Object.entries(darkLeft)) {
            if (count / height >= MIN_DARK_EDGE_PERCENT) {
                box.left = parseInt(left, 10);
                break;
            }
        }

        box.right = null;
        for (const [right, count] of Object.entries(darkRight)) {
            if (count / height >= MIN_DARK_EDGE_PERCENT) {
                box.right = parseInt(right, 10);
            }
        }

        return box.left !== null && box.right !== null;
    }
}

function calcRedIndex(row, col, width) {
    // Assumes RGBA packing
    return (col * 4) + (row * width * 4);
}

function getCL(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return {
        chroma: max - min,
        lightness: (max + min) / 2,
    };
}

function checkPixel(r, g, b, max_chroma, desired_lightness, lightness_variance) {
    const cl = getCL(r, g, b);
    return (cl.chroma <= max_chroma) &&
        (Math.abs(cl.lightness - desired_lightness) < lightness_variance);
}


async function loadResources() {
    return {
        CATALOG: JSON.parse(await fs.readFile(path.join(__dirname, './resources/catalog.json'), 'utf-8')),
        ICON_CLASS_NAMES: JSON.parse(await fs.readFile(path.join(__dirname, './resources/icon_names.json'), 'utf-8')),
        QUANTITY_CLASS_NAMES: JSON.parse(await fs.readFile(path.join(__dirname, './resources/quant_names.json'), 'utf-8')),
        ICON_MODEL_URL: "./resources/icon_model/icon_model.json",
        QUANTITY_MODEL_URL: "./resources/quant_model/quant_model.json",
    };
}

async function main() {
    try {
        const resources = await loadResources();
        console.log('✓ ML resources loaded');

        // Verify input file exists
        await fs.access(options.input);
        console.log('✓ Input file found');

        // Load the image from the specified path
        const image = await loadImage(options.input);
        console.log('✓ Image loaded');

        // Create a canvas with the same dimensions as the image
        const canvas = createCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d');

        // Draw the image onto the canvas
        ctx.drawImage(image, 0, 0);
        console.log('✓ Image processed');

        const result = await process(
            canvas,
            resources.ICON_MODEL_URL,
            resources.ICON_CLASS_NAMES,
            resources.QUANTITY_MODEL_URL,
            resources.QUANTITY_CLASS_NAMES
        );
        console.log('✓ ML analysis complete');

        const simplifiedResults = result.contents.map(item => ({
            quantity: item.quantity,
            codeName: item.CodeName,
            isCrated: item.isCrated
        }));

        // If output file is specified, write results to it
        if (options.output) {
            await fs.writeFile(
                options.output,
                JSON.stringify(simplifiedResults, null, 2),
                'utf8'
            );
            console.log(`✓ Results written to ${options.output}`);
        } else {
            // Otherwise print to console
            console.log(simplifiedResults);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

let models = {};
const CRATED_REGEXP = new RegExp('-crated$');

program
    .option('-i, --input <path>', 'Path to input PNG file')
    .option('-o, --output <path>', 'Path to output JSON file')
    .parse(process.argv);

const options = program.opts();

// Validate required options
if (!options.input) {
    console.error('Error: Input PNG file path is required');
    process.exit(1);
}

main();