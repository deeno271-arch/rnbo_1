async function setup() {
    const patchExportURL = "export/simpsynth.export.json";

    // Create AudioContext
    const WAContext = window.AudioContext || window.webkitAudioContext;
    const context = new WAContext();

    // Create gain node and connect it to audio output
    const outputNode = context.createGain();
    outputNode.connect(context.destination);
    
    // Fetch the exported patcher
    let response, patcher;
    try {
        response = await fetch(patchExportURL);
        patcher = await response.json();
    
        if (!window.RNBO) {
            // Load RNBO script dynamically
            // Note that you can skip this by knowing the RNBO version of your patch
            // beforehand and just include it using a <script> tag
            await loadRNBOScript(patcher.desc.meta.rnboversion);
        }

    } catch (err) {
        const errorContext = {
            error: err
        };
        if (response && (response.status >= 300 || response.status < 200)) {
            errorContext.header = `Couldn't load patcher export bundle`,
            errorContext.description = `Check app.js to see what file it's trying to load. Currently it's` +
            ` trying to load "${patchExportURL}". If that doesn't` + 
            ` match the name of the file you exported from RNBO, modify` + 
            ` patchExportURL in app.js.`;
        }
        if (typeof guardrails === "function") {
            guardrails(errorContext);
        } else {
            throw err;
        }
        return;
    }
    
    // (Optional) Fetch the dependencies
    let dependencies = [];
    try {
        const dependenciesResponse = await fetch("export/dependencies.json");
        dependencies = await dependenciesResponse.json();

        // Prepend "export" to any file dependenciies
        dependencies = dependencies.map(d => d.file ? Object.assign({}, d, { file: "export/" + d.file }) : d);
    } catch (e) {}

    // Create the device
    let device;
    try {
        device = await RNBO.createDevice({ context, patcher });
    } catch (err) {
        if (typeof guardrails === "function") {
            guardrails({ error: err });
        } else {
            throw err;
        }
        return;
    }

    // (Optional) Load the samples
    if (dependencies.length)
        await device.loadDataBufferDependencies(dependencies);

    // Connect the device to the web audio graph
    device.node.connect(outputNode);
    drawWaveform(context, outputNode);

    // (Optional) Extract the name and rnbo version of the patcher from the description
    document.getElementById("patcher-title").innerText = (patcher.desc.meta.filename || "Unnamed Patcher") + " (v" + patcher.desc.meta.rnboversion + ")";

    // (Optional) Automatically create sliders for the device parameters
    makeSliders(device);

    makeADSRDials(device);

    // (Optional) Attach listeners to outports so you can log messages from the RNBO patcher
    attachOutports(device);

    // (Optional) Load presets, if any
    loadPresets(device, patcher);

    connectMIDIInputs(device);

    document.body.onclick = () => {
        context.resume();
    }

    // Skip if you're not using guardrails.js
    if (typeof guardrails === "function")
        guardrails();
}

function loadRNBOScript(version) {
    return new Promise((resolve, reject) => {
        if (/^\d+\.\d+\.\d+-dev$/.test(version)) {
            throw new Error("Patcher exported with a Debug Version!\nPlease specify the correct RNBO version to use in the code.");
        }
        const el = document.createElement("script");
        el.src = "https://c74-public.nyc3.digitaloceanspaces.com/rnbo/" + encodeURIComponent(version) + "/rnbo.min.js";
        el.onload = resolve;
        el.onerror = function(err) {
            console.log(err);
            reject(new Error("Failed to load rnbo.js v" + version));
        };
        document.body.append(el);
    });
}

function makeSliders(device) {
    let pdiv = document.getElementById("rnbo-parameter-sliders");
    let noParamLabel = document.getElementById("no-param-label");
    if (noParamLabel && device.numParameters > 0) pdiv.removeChild(noParamLabel);

    // This will allow us to ignore parameter update events while dragging the slider.
    let isDraggingSlider = false;
    let uiElements = {};

    device.parameters.forEach(param => {
        // Subpatchers also have params. If we want to expose top-level
        // params only, the best way to determine if a parameter is top level
        // or not is to exclude parameters with a '/' in them.
        // You can uncomment the following line if you don't want to include subpatcher params
        
        //if (param.id.includes("/")) return;

        // Create a label, an input slider and a value display
        let label = document.createElement("label");
        let slider = document.createElement("input");
        let text = document.createElement("input");
        let sliderContainer = document.createElement("div");
        sliderContainer.appendChild(label);
        sliderContainer.appendChild(slider);
        sliderContainer.appendChild(text);

        // Add a name for the label
        label.setAttribute("name", param.name);
        label.setAttribute("for", param.name);
        label.setAttribute("class", "param-label");
        label.textContent = `${param.name}: `;

        // Make each slider reflect its parameter
        slider.setAttribute("type", "range");
        slider.setAttribute("class", "param-slider");
        slider.setAttribute("id", param.id);
        slider.setAttribute("name", param.name);
        slider.setAttribute("min", param.min);
        slider.setAttribute("max", param.max);
        if (param.steps > 1) {
            slider.setAttribute("step", (param.max - param.min) / (param.steps - 1));
        } else {
            slider.setAttribute("step", (param.max - param.min) / 1000.0);
        }
        slider.setAttribute("value", param.value);

        // Make a settable text input display for the value
        text.setAttribute("value", param.value.toFixed(1));
        text.setAttribute("type", "text");

        // Make each slider control its parameter
        slider.addEventListener("pointerdown", () => {
            isDraggingSlider = true;
        });
        slider.addEventListener("pointerup", () => {
            isDraggingSlider = false;
            slider.value = param.value;
            text.value = param.value.toFixed(1);
        });
        slider.addEventListener("input", () => {
            let value = Number.parseFloat(slider.value);
            param.value = value;
        });

        // Make the text box input control the parameter value as well
        text.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
                let newValue = Number.parseFloat(text.value);
                if (isNaN(newValue)) {
                    text.value = param.value;
                } else {
                    newValue = Math.min(newValue, param.max);
                    newValue = Math.max(newValue, param.min);
                    text.value = newValue;
                    param.value = newValue;
                }
            }
        });

        // Store the slider and text by name so we can access them later
        uiElements[param.id] = { slider, text };

        // Add the slider element
        pdiv.appendChild(sliderContainer);
    });

    // Listen to parameter changes from the device
    device.parameterChangeEvent.subscribe(param => {
        if (!isDraggingSlider)
            uiElements[param.id].slider.value = param.value;
        uiElements[param.id].text.value = param.value.toFixed(1);
    });
}

function makeADSRDials(device) {
    const container = document.getElementById("adsr-dials");
    const oscillator = document.getElementById("oscillator-dials");
    const envelope = document.getElementById("envelope-display");
    const envelopePositions = { attack: 0, decay: 0, sustain: 0, release: 0 };
    const status = document.getElementById("adsr-status");
    const inports = device.messages.filter(message => message.type === RNBO.MessagePortType.Inport);
    const missingInports = [];
    const controls = [
        { name: "attack", min: 0.1, max: 2000, exponent: 4, unit: " ms" },
        { name: "decay", min: 0.1, max: 2000, exponent: 4, unit: " ms" },
        { name: "sustain", min: 0, max: 1, exponent: 2, unit: "" },
        { name: "release", min: 0.1, max: 2000, exponent: 4, unit: " ms" },
        { name: "pwm", min: 0, max: 1, exponent: 1, unit: "" }
    ];

    for (const { name, min, max, exponent, unit } of controls) {
        const control = document.createElement("div");
        control.className = "adsr-control";
        const label = document.createElement("label");
        label.htmlFor = "adsr-" + name;
        label.textContent = name === "pwm" ? "PWM" : name;

        const dial = document.createElement("div");
        dial.className = "adsr-dial";
        const input = document.createElement("input");
        input.type = "range";
        input.id = label.htmlFor;
        input.min = 0;
        input.max = 1;
        input.step = 0.001;
        input.value = 0;
        input.setAttribute("aria-valuetext", min + unit);
        input.disabled = !inports.some(inport => inport.tag === name);
        if (input.disabled) missingInports.push(name);

        let dragStartY;
        let dragStartPosition;
        input.addEventListener("pointerdown", event => {
            if (!event.isPrimary || event.button !== 0) return;
            event.preventDefault();
            input.focus();
            dragStartY = event.clientY;
            dragStartPosition = input.valueAsNumber;
            input.setPointerCapture(event.pointerId);
        });
        function updateDrag(event) {
            if (!input.hasPointerCapture(event.pointerId)) return;
            const position = dragStartPosition + (dragStartY - event.clientY) / 180;
            const previousPosition = input.valueAsNumber;
            input.valueAsNumber = Math.max(0, Math.min(1, position));
            if (input.valueAsNumber !== previousPosition) {
                input.dispatchEvent(new Event("input", { bubbles: true }));
            }
        }
        input.addEventListener("pointermove", updateDrag);
        input.addEventListener("pointerup", updateDrag);

        const readout = document.createElement("span");
        readout.textContent = min + "–" + max + unit;
        input.addEventListener("input", () => {
            const position = input.valueAsNumber;
            const value = min + (max - min) * position ** exponent;
            const angle = -135 + 270 * position;
            dial.style.setProperty("--dial-angle", angle + "deg");
            readout.textContent = Number(value.toFixed(3)) + unit;
            input.setAttribute("aria-valuetext", readout.textContent);
            device.scheduleEvent(new RNBO.MessageEvent(RNBO.TimeNow, name, [value]));
            if (name in envelopePositions) {
                envelopePositions[name] = (value - min) / (max - min);
                drawEnvelope(envelope, envelopePositions);
            }
        });

        dial.append(input);
        control.append(label, dial, readout);
        const target = name === "pwm" ? oscillator : container;
        target.append(control);
    }

    drawEnvelope(envelope, envelopePositions);
    status.hidden = missingInports.length === 0;
    status.textContent = "Missing RNBO inports: " + missingInports.join(", ");
}

function drawEnvelope(canvas, { attack, decay, sustain, release }) {
    const drawing = canvas.getContext("2d");
    const { width, height } = canvas;
    const peak = width * (0.12 + attack * 0.16);
    const decayEnd = peak + width * (0.1 + decay * 0.14);
    const releaseEnd = width * (0.78 + release * 0.18);
    const sustainY = height * (0.86 - sustain * 0.72);
    drawing.clearRect(0, 0, width, height);
    drawing.beginPath();
    drawing.moveTo(width * 0.04, height * 0.86);
    drawing.lineTo(peak, height * 0.14);
    drawing.lineTo(decayEnd, sustainY);
    drawing.lineTo(width * 0.68, sustainY);
    drawing.lineTo(releaseEnd, height * 0.86);
    drawing.lineWidth = 4;
    drawing.lineJoin = "round";
    drawing.strokeStyle = "#ffc0a7";
    drawing.stroke();
}

function drawWaveform(context, outputNode) {
    const canvas = document.getElementById("waveform-display");
    const drawing = canvas.getContext("2d");
    const analyser = context.createAnalyser();
    const samples = new Float32Array(analyser.fftSize);
    outputNode.connect(analyser);
    drawing.lineWidth = 3;
    drawing.strokeStyle = "#a8e5d0";

    function render() {
        analyser.getFloatTimeDomainData(samples);
        drawing.clearRect(0, 0, canvas.width, canvas.height);
        drawing.beginPath();
        for (let x = 0; x < canvas.width; x++) {
            const sample = samples[Math.floor(x * samples.length / canvas.width)];
            const y = canvas.height * (0.5 - sample * 0.45);
            if (x === 0) drawing.moveTo(x, y);
            else drawing.lineTo(x, y);
        }
        drawing.stroke();
        requestAnimationFrame(render);
    }

    render();
}

function attachOutports(device) {
    const outports = device.outports;
    if (outports.length < 1) {
        document.getElementById("rnbo-console").removeChild(document.getElementById("rnbo-console-div"));
        return;
    }

    document.getElementById("rnbo-console").removeChild(document.getElementById("no-outports-label"));
    device.messageEvent.subscribe((ev) => {

        // Ignore message events that don't belong to an outport
        if (outports.findIndex(elt => elt.tag === ev.tag) < 0) return;

        // Message events have a tag as well as a payload
        console.log(`${ev.tag}: ${ev.payload}`);

        document.getElementById("rnbo-console-readout").innerText = `${ev.tag}: ${ev.payload}`;
    });
}

function loadPresets(device, patcher) {
    let presets = patcher.presets || [];
    if (presets.length < 1) {
        document.getElementById("rnbo-presets").removeChild(document.getElementById("preset-select"));
        return;
    }

    document.getElementById("rnbo-presets").removeChild(document.getElementById("no-presets-label"));
    let presetSelect = document.getElementById("preset-select");
    presets.forEach((preset, index) => {
        const option = document.createElement("option");
        option.innerText = preset.name;
        option.value = index;
        presetSelect.appendChild(option);
    });
    presetSelect.onchange = () => device.setPreset(presets[presetSelect.value].preset);
}

function connectMIDIInputs(device) {
    const button = document.getElementById("enable-midi");
    const status = document.getElementById("midi-status");
    const noteReadout = document.getElementById("midi-note");
    const picker = document.getElementById("midi-input-picker");
    const select = document.getElementById("midi-input-select");
    if (device.numMIDIInputPorts === 0) {
        status.textContent = "This RNBO patch has no MIDI input.";
        return;
    }
    if (!navigator.requestMIDIAccess) {
        status.textContent = "Web MIDI requires a supported browser and a secure context (HTTPS or localhost).";
        return;
    }

    let selectedInput = null;
    const heldNotes = new Set();

    function scheduleMIDI(data) {
        const timeMs = device.context.currentTime * 1000;
        device.scheduleEvent(new RNBO.MIDIEvent(timeMs, 0, data));
    }

    function forwardMessage(event) {
        const [message, note, velocity] = event.data;
        const noteKey = ((message & 0x0f) << 7) | note;
        if ((message & 0xf0) === 0x90 && velocity > 0) {
            heldNotes.add(noteKey);
            const channel = (message & 0x0f) + 1;
            const inputName = event.currentTarget.name || "MIDI input";
            noteReadout.textContent = `${inputName}: note ${note}, channel ${channel}, velocity ${velocity}`;
        } else if ((message & 0xf0) === 0x80 || (message & 0xf0) === 0x90) {
            heldNotes.delete(noteKey);
        }
        scheduleMIDI(Array.from(event.data));
    }

    function selectInput(input) {
        if (selectedInput === input) return;
        if (selectedInput) {
            selectedInput.removeEventListener("midimessage", forwardMessage);
            for (const noteKey of heldNotes) {
                scheduleMIDI([0x80 | (noteKey >> 7), noteKey & 0x7f, 0]);
            }
            heldNotes.clear();
        }
        selectedInput = input;
        noteReadout.textContent = "No MIDI notes received yet.";
        if (input) input.addEventListener("midimessage", forwardMessage);
    }

    button.disabled = false;
    status.textContent = "Enable MIDI to connect your keyboard.";
    button.addEventListener("click", async (event) => {
        event.stopPropagation();
        button.disabled = true;
        status.textContent = "Requesting MIDI access…";
        try {
            const [access] = await Promise.all([
                navigator.requestMIDIAccess(),
                device.context.resume()
            ]);

            function updateInputs() {
                const inputs = Array.from(access.inputs.values()).filter(input => input.state === "connected");
                const activeInput = inputs.find(input => input.id === selectedInput?.id) || inputs[0];
                select.replaceChildren(...inputs.map(input => new Option(input.name || "MIDI input", input.id)));
                select.disabled = !activeInput;
                select.value = activeInput?.id || "";
                selectInput(activeInput || null);
                status.textContent = activeInput ? "" : "Connect a MIDI keyboard.";
            }

            select.addEventListener("change", () => selectInput(access.inputs.get(select.value) || null));
            access.addEventListener("statechange", (event) => {
                if (event.port.type === "input") updateInputs();
            });
            updateInputs();
            picker.hidden = false;
            noteReadout.hidden = false;
            button.hidden = true;
        } catch (error) {
            status.textContent = "Could not start MIDI: " + error.message;
            button.disabled = false;
        }
    });
}

setup();
