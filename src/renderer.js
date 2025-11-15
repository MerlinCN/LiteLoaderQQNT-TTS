import { Contact } from './utils/rendererUtils.js';

// 运行在 Electron 渲染进程 下的页面脚本
const pluginPath = LiteLoader.plugins["text_to_speech"].path.plugin;

let optionsList = null;
let mainOption = null;
let currentOption = null;

let tmpParamKey = "请输入参数Key后点击确认";
let tmpParamValue = "待修改参数值";
let tmpHeaderKey = "";
let tmpHeaderValue = "";

// 配置管理工具函数
const configManager = {
    async getMainOption() {
        if (!mainOption) mainOption = await LiteLoader.api.config.get("text_to_speech");
        return mainOption;
    },
    async getOptionsList() {
        if (!optionsList) {
            const opt = await this.getMainOption();
            optionsList = opt.availableOptions;
        }
        return optionsList;
    },
    async getCurrentOption() {
        if (!currentOption) {
            const opt = await this.getMainOption();
            currentOption = await text_to_speech.getSubOptions(opt.currentOption);
        }
        return currentOption;
    },
    async setMainOption(opt) {
        mainOption = opt;
        await LiteLoader.api.config.set("text_to_speech", mainOption);
    },
    async setCurrentOption(optName) {
        mainOption.currentOption = optName;
        await this.setMainOption(mainOption);
        currentOption = await text_to_speech.getSubOptions(optName);
        return currentOption;
    },
    async refreshOptionsList() {
        const jsonFilesNames = await text_to_speech.getLocalSubOptionsList();
        mainOption.availableOptions = jsonFilesNames;
        await this.setMainOption(mainOption);
        optionsList = mainOption.availableOptions;
        return optionsList;
    }
};

const logger = {
    info: function (...args) {
        console.log(`[Text_to_speech]`, ...args);
    },
    warn: function (...args) {
        console.warn(`[Text_to_speech]`, ...args);
    },
    error: function (...args) {
        console.error(`[Text_to_speech]`, ...args);
        alert(`[Text_to_speech]` + args.join(" "));
    }
};


/**
 * 将十六进制字符串转换为 ArrayBuffer
 * @param {string} hexString - 十六进制编码的字符串
 * @returns {ArrayBuffer}
 */
function hexToArrayBuffer(hexString) {
    const bytes = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
        bytes[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
    }
    return bytes.buffer;
}

/**
 * 根据 host_type 解析不同格式的响应
 * @param {Response} response - fetch 响应对象
 * @param {string} hostType - API 类型 (vits, minimax 等)
 * @returns {Promise<ArrayBuffer>}
 */
async function parseResponse(response, hostType) {
    if (!response.ok) {
        throw new Error(`HTTP error, status = ${response.status}`);
    }

    // 根据不同的 API 类型处理响应
    switch (hostType) {
        case 'minimax': {
            // minimax 返回 JSON，音频数据在 data.audio 字段（十六进制编码）
            const jsonData = await response.json();
            if (jsonData.base_resp?.status_code !== 0) {
                throw new Error(`Minimax API error: ${jsonData.base_resp?.status_msg || 'Unknown error'}`);
            }
            const hexAudio = jsonData.data?.audio;
            if (!hexAudio) {
                throw new Error('Minimax response missing data.audio field');
            }
            logger.info(`Minimax 音频信息: 格式=${jsonData.extra_info?.audio_format}, 大小=${jsonData.extra_info?.audio_size}, 时长=${jsonData.extra_info?.audio_length}ms`);
            return hexToArrayBuffer(hexAudio);
        }

        case 'vits':
        default:
            // 默认处理：直接返回二进制音频数据
            return response.arrayBuffer();
    }
}

function requestPost(hosturl, params, customHeaders = {}, hostType = 'vits') {
    const headers = {
        'Content-Type': 'application/json',
        ...customHeaders
    };
    logger.info("headers: ", headers);
    logger.info("params: ", params);
    return fetch(hosturl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(params)
    }).then((response) => parseResponse(response, hostType));
}

function requestGet(hosturl, params, customHeaders = {}, hostType = 'vits') {
    // 处理参数
    let url = new URL(hosturl);
    let searchParams = new URLSearchParams(params);
    let searchParamsInURL = new URLSearchParams(url.search);
    searchParamsInURL.forEach((value, key) => {
        searchParams.append(key, value);
    });
    url.search = searchParams;
    return fetch(url, {
        headers: customHeaders
    }).then((response) => parseResponse(response, hostType));
}

function callTTS(sourceText, targetLang, optionsCache) {
    logger.info("转换文本：", sourceText, "到(语言)：", targetLang);
    logger.info("optionsCache: ", optionsCache);
    let http_type = optionsCache?.http_type;
    logger.info("http_type: ", http_type);
    if (http_type == undefined) {
        http_type = "get";
    }
    const host_type = optionsCache?.host_type || 'vits';
    let params = optionsCache.params;
    params[params.source_key] = sourceText;
    const headers = optionsCache.headers || {};
    if (http_type == "get") {
        return requestGet(optionsCache.host, params, headers, host_type);
    } else if (http_type == "post") {
        return requestPost(optionsCache.host, params, headers, host_type);
    }
}

// 点击群助手后chat-func-bar会消失，再点群聊才会出现，所以需要再写一个监听
function observeElement2(selector, callback, callbackEnable = true, interval = 100) {
    try {
        const timer = setInterval(function () {
            const element = document.querySelector(selector);
            if (element) {
                if (callbackEnable) {
                    callback();
                }
            }
        }, interval);
    } catch (error) {
        logger.error("[检测元素错误]", error);
    }
}

// 渲染动态参数的函数

/**
 * 获取参数值的类型
 * @param {*} value - 参数值
 * @returns {string} - 'boolean', 'object', 'number', 'string'
 */
function getParamType(value) {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'object' && value !== null) return 'object';
    if (typeof value === 'number') return 'number';
    return 'string';
}

/**
 * 根据参数类型渲染对应的输入控件
 * @param {*} paramValue - 参数值
 * @param {string} paramType - 参数类型
 * @returns {string} - HTML 字符串
 */
function renderParamInput(paramValue, paramType) {
    switch (paramType) {
        case 'boolean':
            return `
                <select class="param-value param-value-boolean" data-type="boolean">
                    <option value="true" ${paramValue === true ? 'selected' : ''}>true</option>
                    <option value="false" ${paramValue === false ? 'selected' : ''}>false</option>
                </select>
            `;
        case 'object':
            return `
                <textarea class="param-value param-value-object" data-type="object" rows="3" style="flex: 1; resize: vertical; font-family: monospace; padding: 6px 10px;">${JSON.stringify(paramValue, null, 2)}</textarea>
            `;
        case 'number':
            return `
                <input class="param-value param-value-number" data-type="number" type="number" value="${paramValue}" step="any" />
            `;
        default: // string
            const escapedValue = String(paramValue).replace(/"/g, '&quot;');
            return `
                <input class="param-value param-value-string" data-type="string" type="text" value="${escapedValue}" />
            `;
    }
}

function renderParams(view, optionsEditing) {
    const paramsContainer = view.querySelector(".text_to_speech .params-container");
    paramsContainer.innerHTML = '';
    Object.entries(optionsEditing.params || {}).forEach(([paramKey, paramValue]) => {
        const paramElement = document.createElement("setting-item");
        paramElement.classList.add("param-entry");
        paramElement.setAttribute("data-direction", "row");
        let desc = '';
        if (paramKey === "source_key") desc = `title="source_key用于指示输入内容对应参数的key"`;
        if (paramKey === "format") desc = `title="format用于指示接口返回音频内容的格式"`;

        const paramType = getParamType(paramValue);
        const inputHtml = renderParamInput(paramValue, paramType);

        paramElement.innerHTML = `
            <div class="input-group" style="align-items: flex-start;">
                <input class="param-key" ${desc} type="text" value="${paramKey}" readonly />
                ${inputHtml}
                <span class="param-type-indicator" style="min-width: 60px; padding: 6px 10px; font-size: 0.85em; color: #666;">${paramType}</span>
                <div class="ops-btns">
                    <setting-button data-type="secondary" class="param-remove">移除</setting-button>
                </div>
            </div>
        `;
        paramsContainer.appendChild(paramElement);
        paramElement.querySelector(".param-remove").addEventListener("click", () => {
            if (["source_key", "format"].includes(paramKey)) {
                alert(`${paramKey}为关键参数，无法删除`);
            } else {
                delete optionsEditing.params[paramKey];
                renderParams(view, optionsEditing);
                console.log(optionsEditing);
            }
        });

        const valueInput = paramElement.querySelector(".param-value");
        const dataType = valueInput.getAttribute("data-type");

        if (dataType === 'boolean') {
            valueInput.addEventListener("change", (e) => {
                optionsEditing.params[paramKey] = e.target.value === 'true';
            });
        } else if (dataType === 'object') {
            valueInput.addEventListener("input", (e) => {
                try {
                    optionsEditing.params[paramKey] = JSON.parse(e.target.value);
                    valueInput.style.borderColor = '';
                } catch (error) {
                    // JSON 解析失败时显示红色边框提示
                    valueInput.style.borderColor = 'red';
                }
            });
        } else if (dataType === 'number') {
            valueInput.addEventListener("input", (e) => {
                const num = parseFloat(e.target.value);
                optionsEditing.params[paramKey] = isNaN(num) ? 0 : num;
            });
        } else {
            valueInput.addEventListener("input", (e) => {
                optionsEditing.params[paramKey] = e.target.value;
            });
        }
    });
}

// 渲染动态请求头的函数
function renderHeaders(view, optionsEditing) {
    const headersContainer = view.querySelector(".text_to_speech .headers-container");
    headersContainer.innerHTML = '';
    // 确保 headers 对象存在
    if (!optionsEditing.headers) {
        optionsEditing.headers = {};
    }
    Object.entries(optionsEditing.headers || {}).forEach(([headerKey, headerValue]) => {
        const headerElement = document.createElement("setting-item");
        headerElement.classList.add("header-entry");
        headerElement.setAttribute("data-direction", "row");

        const headerType = getParamType(headerValue);
        const inputHtml = renderParamInput(headerValue, headerType);

        headerElement.innerHTML = `
            <div class="input-group" style="align-items: flex-start;">
                <input class="header-key" type="text" value="${headerKey}" readonly />
                ${inputHtml}
                <span class="param-type-indicator" style="min-width: 60px; padding: 6px 10px; font-size: 0.85em; color: #666;">${headerType}</span>
                <div class="ops-btns">
                    <setting-button data-type="secondary" class="header-remove">移除</setting-button>
                </div>
            </div>
        `;
        headersContainer.appendChild(headerElement);
        headerElement.querySelector(".header-remove").addEventListener("click", () => {
            delete optionsEditing.headers[headerKey];
            renderHeaders(view, optionsEditing);
            console.log(optionsEditing);
        });

        const valueInput = headerElement.querySelector(".param-value");
        const dataType = valueInput.getAttribute("data-type");

        if (dataType === 'boolean') {
            valueInput.addEventListener("change", (e) => {
                optionsEditing.headers[headerKey] = e.target.value === 'true';
            });
        } else if (dataType === 'object') {
            valueInput.addEventListener("input", (e) => {
                try {
                    optionsEditing.headers[headerKey] = JSON.parse(e.target.value);
                    valueInput.style.borderColor = '';
                } catch (error) {
                    valueInput.style.borderColor = 'red';
                }
            });
        } else if (dataType === 'number') {
            valueInput.addEventListener("input", (e) => {
                const num = parseFloat(e.target.value);
                optionsEditing.headers[headerKey] = isNaN(num) ? 0 : num;
            });
        } else {
            valueInput.addEventListener("input", (e) => {
                optionsEditing.headers[headerKey] = e.target.value;
            });
        }
    });
}

const icon = `<svg fill="currentColor" stroke="" stroke-width="1.5" viewBox="0 0 1092 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M1010.551467 424.925867c0 86.016-65.365333 155.886933-147.0464 166.638933H819.882667c-81.681067-10.752-147.0464-80.622933-147.0464-166.638933H580.266667c0 123.630933 92.603733 231.1168 212.411733 252.6208V785.066667h87.176533v-107.52C999.662933 656.042667 1092.266667 553.915733 1092.266667 424.96h-81.7152z m-76.253867-231.150934C934.2976 140.014933 890.743467 102.4 841.728 102.4a91.204267 91.204267 0 0 0-92.603733 91.374933v91.374934h190.634666V193.774933h-5.461333z m-190.634667 231.150934c0 53.76 43.588267 91.374933 92.603734 91.374933a91.204267 91.204267 0 0 0 92.603733-91.374933V333.550933h-185.207467v91.374934zM464.213333 150.698667L324.266667 10.24l-6.826667-6.826667L314.026667 0l-3.413334 3.413333-6.826666 6.8608-20.48 20.548267-3.413334 3.413333 3.413334 6.8608 13.653333 13.687467 75.093333 75.3664H218.453333c-122.88 6.826667-218.453333 109.568-218.453333 229.444267v10.274133h51.2v-10.24c0-92.501333 75.093333-171.281067 167.253333-178.107733h153.6L296.96 256.853333l-10.24 10.274134-3.413333 6.826666-3.413334 3.447467 3.413334 3.413333 27.306666 27.409067 3.413334 3.413333 3.413333-3.413333 30.72-30.8224 116.053333-116.4288 3.413334-3.413333-3.413334-6.8608zM58.026667 534.254933v130.1504h64.853333v-65.058133h129.706667v359.594667H187.733333V1024h194.56v-65.058133H317.44V599.3472h129.706667v65.058133H512v-130.1504H58.026667z"></path></svg>`

observeElement2(".chat-func-bar", function () {
    // 获取消息栏的左侧图标区域（就是chat-func-bar的第一个子元素）
    const iconBarLeft = document.querySelector(".chat-func-bar").firstElementChild;

    // 判断是否已经添加过tts-bar-icon
    if (iconBarLeft.querySelector("#tts-bar-icon")) {
        return;
    }

    // 复制iconBarLeft的第一个子元素
    // const barIcon = iconBarLeft.firstElementChild.cloneNode(true);
    const barIcon = iconBarLeft.querySelector(".bar-icon").cloneNode(true); // 根据 https://github.com/lclichen/LiteLoaderQQNT-TTS/issues/4 修改
    // 将id-func-bar-expression替换为id-func-bar-tts_on
    barIcon.querySelector("#id-func-bar-expression").id = "tts-bar-icon";
    // 将svg替换为上面的svg
    barIcon.querySelector("svg").outerHTML = icon;
    // 将aria-label的值替换为发送TTS消息，似乎不会生效，以后再改
    barIcon.querySelector("#tts-bar-icon").setAttribute("aria-label", "发送TTS消息");
    // 添加一个快速选择配置的下拉小箭头
    const arrowIcon = document.createElement('div');
    arrowIcon.className = "arrow";
    const arrowIconChild = document.createElement('i');
    arrowIconChild.className = "q-svg-icon q-icon lite-tools-vue-component vue-component";
    arrowIconChild.id = "tts-bar-icon-arrow";
    arrowIconChild.setAttribute("bf-toolbar-item", "")
    arrowIconChild.setAttribute("role", "button")
    arrowIconChild.setAttribute("tabindex", "-1")
    arrowIconChild.setAttribute("bf-label-inner", "true")
    arrowIconChild.setAttribute("aria-label", "TTS配置选择");
    arrowIconChild.style = "width: 16px; height: 16px; --234e3e61: inherit;";

    arrowIconChild.innerHTML = '<svg viewBox="0 0 16 16"><use xlink:href="/_upper_/resource/icons/setting_24.svg#setting_24"></use></svg>';

    arrowIcon.appendChild(arrowIconChild);

    // 将barIcon添加到iconBarLeft的最后
    iconBarLeft.appendChild(barIcon);

    // 给barIcon->child->ttsSenderIcon添加点击事件
    const ttsSenderIcon = barIcon.querySelector("#tts-bar-icon");
    ttsSenderIcon.addEventListener("click", async () => {
        if (document.querySelector("#tts-notice") != undefined) {
            return;
        }
        const currentContact = Contact.getCurrentContact();
        const content = document.querySelector('.ck-editor__editable');
        const sourceText = content.innerText;
        const noticeElement = document.createElement('div');
        const noticeElementChild = document.createElement('div');
        if (mainOption == null) {
            mainOption = await LiteLoader.api.config.get("text_to_speech");
        }
        if (currentOption == null) {
            currentOption = await text_to_speech.getSubOptions(mainOption.currentOption);
        }
        if (mainOption.enableTTSPreview) {
            noticeElement.className = "q-tooltips__content q-tooltips__bottom";
            noticeElement.style = "bottom: -31px; transform: translateX(-50%); left: 50%;";
            noticeElementChild.id = "tts-notice";
            noticeElementChild.className = "primary-content";
            noticeElementChild.textContent = "转换中...";
            noticeElement.appendChild(noticeElementChild);
            barIcon.firstChild.appendChild(noticeElement);
        }

        // 调用TTS接口
        let buffer = null;
        try {
            buffer = await callTTS(sourceText, "中文", currentOption);
        } catch (error) {
            logger.error("[转换出错][TTS接口调用不成功]", error);
        }

        // 将buffer通过ffmpeg转换为pcm格式
        let result = null;
        try {
            if (mainOption.enableTTSCache) {
                result = await text_to_speech.saveFile(`tts@${Date.now()}.${currentOption.params.format}`, buffer);
            }
            else {
                result = await text_to_speech.saveFile(`tts.${currentOption.params.format}`, buffer);
            }
        } catch (error) {
            logger.error("[转换出错][格式转换不成功，请检查ffmpeg配置]", error);
        }
        logger.info(result);

        if (result.res == "success") {
            const silkData = await text_to_speech.getSilk(result.file);
            logger.info(silkData);

            if (mainOption.enableTTSPreview) {
                // 增加预览功能
                noticeElementChild.textContent = "转换完成.";
                const audioChild = document.createElement('audio');
                audioChild.id = "audioPlayer";
                audioChild.setAttribute('controls', true)
                audioChild.src = await text_to_speech.readAudioAsBase64(result.origin);
                noticeElement.appendChild(audioChild);
                const sendButton = document.createElement('button');
                sendButton.id = "tts-send-button";
                sendButton.className = "q-button q-button--small q-button--primary";
                sendButton.textContent = "发送";
                sendButton.style = "float: right;";

                const regenButton = document.createElement('button');
                regenButton.id = "tts-regen-button";
                regenButton.className = "q-button q-button--small q-button--primary";
                regenButton.textContent = "重新生成";

                const cancelButton = document.createElement('button');
                cancelButton.id = "tts-cancel-button";
                cancelButton.className = "q-button q-button--small q-button--secondary";
                cancelButton.textContent = "取消";

                const ttsButtonBar = document.createElement('div');
                ttsButtonBar.className = "tts-button-bar";
                ttsButtonBar.appendChild(regenButton);
                ttsButtonBar.appendChild(cancelButton);
                ttsButtonBar.appendChild(sendButton);

                noticeElement.appendChild(ttsButtonBar);
                noticeElement.addEventListener("click", (e) => {
                    e.stopPropagation();
                });

                noticeElement.querySelector('#tts-send-button').addEventListener("click", async (e) => {
                    currentContact.sendPttMessage(silkData);
                    barIcon.firstChild.removeChild(noticeElement);
                    e.stopPropagation();
                });
                noticeElement.querySelector('#tts-regen-button').addEventListener("click", async (e) => {
                    barIcon.firstChild.removeChild(noticeElement);
                    e.stopPropagation();
                    ttsSenderIcon.click();
                });
                noticeElement.querySelector('#tts-cancel-button').addEventListener("click", async (e) => {
                    barIcon.firstChild.removeChild(noticeElement);
                    e.stopPropagation();
                });
            }
            else {
                currentContact.sendPttMessage(silkData);
            }
        } else {
            logger.warn(result.msg);
            if (mainOption.enableTTSPreview) {
                barIcon.firstChild.removeChild(noticeElement);
            }
        }
    });

    // 需要额外添加一个配置列表的选择项
    barIcon.firstChild.appendChild(arrowIcon)
    arrowIcon.addEventListener("click", async () => {
        if (barIcon.firstChild.querySelector("#tts-option-quick-selector") != undefined) {
            barIcon.firstChild.removeChild(barIcon.firstChild.querySelector("#tts-option-quick-selector"));
            return;
        }
        // 显示可选配置列表
        if (mainOption == null) {
            mainOption = await LiteLoader.api.config.get("text_to_speech");
        }
        if (optionsList == null) {
            optionsList = mainOption.availableOptions;
        }
        if (currentOption == null) {
            currentOption = await text_to_speech.getSubOptions(mainOption.currentOption);
        }
        const optionQSelector = document.createElement('select');
        optionQSelector.id = "tts-option-quick-selector";
        optionQSelector.innerHTML = optionsList.map((optionName) => {
            return `<option value="${optionName}" ${optionName === mainOption.currentOption ? "selected" : ""}>${optionName}</option>`;
        }).join("");
        barIcon.firstChild.appendChild(optionQSelector);
        optionQSelector.addEventListener("change", async (e) => {
            mainOption.currentOption = e.target.value;
            await LiteLoader.api.config.set("text_to_speech", mainOption);
            currentOption = await text_to_speech.getSubOptions(mainOption.currentOption);
            barIcon.firstChild.removeChild(optionQSelector);
        });
    })
});

document.addEventListener('drop', e => {
    if (document.querySelector(".audio-msg-input") != undefined) {
        e.dataTransfer.files.forEach(async file => {
            const currentContact = Contact.getCurrentContact();
            const result = await text_to_speech.convertAndSaveFile(file.path);
            // 这一步应该增加格式转换功能
            logger.info(result);
            if (result.res == "success") {
                const silkData = await text_to_speech.getSilk(result.file);
                logger.info(silkData);
                currentContact.sendPttMessage(silkData);
            } else {
                logger.warn(result.msg);
            }
        });
    }
});

// 打开设置界面时触发

export const onSettingWindowCreated = async view => {
    const html_file_path = `local:///${pluginPath}/src/settings.html`;
    const htmlText = await (await fetch(html_file_path)).text();
    view.insertAdjacentHTML('afterbegin', htmlText);

    // 添加插件图标
    document.querySelectorAll(".nav-bar.liteloader > .nav-item").forEach((node) => {
        if (node.textContent === "文本转语音") {
            node.querySelector(".q-icon").innerHTML = `<svg fill="currentColor" stroke-width="1.5" viewBox="0 0 1092 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M1010.551467 424.925867c0 86.016-65.365333 155.886933-147.0464 166.638933H819.882667c-81.681067-10.752-147.0464-80.622933-147.0464-166.638933H580.266667c0 123.630933 92.603733 231.1168 212.411733 252.6208V785.066667h87.176533v-107.52C999.662933 656.042667 1092.266667 553.915733 1092.266667 424.96h-81.7152z m-76.253867-231.150934C934.2976 140.014933 890.743467 102.4 841.728 102.4a91.204267 91.204267 0 0 0-92.603733 91.374933v91.374934h190.634666V193.774933h-5.461333z m-190.634667 231.150934c0 53.76 43.588267 91.374933 92.603734 91.374933a91.204267 91.204267 0 0 0 92.603733-91.374933V333.550933h-185.207467v91.374934zM464.213333 150.698667L324.266667 10.24l-6.826667-6.826667L314.026667 0l-3.413334 3.413333-6.826666 6.8608-20.48 20.548267-3.413334 3.413333 3.413334 6.8608 13.653333 13.687467 75.093333 75.3664H218.453333c-122.88 6.826667-218.453333 109.568-218.453333 229.444267v10.274133h51.2v-10.24c0-92.501333 75.093333-171.281067 167.253333-178.107733h153.6L296.96 256.853333l-10.24 10.274134-3.413333 6.826666-3.413334 3.447467 3.413334 3.413333 27.306666 27.409067 3.413334 3.413333 3.413333-3.413333 30.72-30.8224 116.053333-116.4288 3.413334-3.413333-3.413334-6.8608zM58.026667 534.254933v130.1504h64.853333v-65.058133h129.706667v359.594667H187.733333V1024h194.56v-65.058133H317.44V599.3472h129.706667v65.058133H512v-130.1504H58.026667z"></path></svg>`;
        }
    });

    // 获取配置列表
    mainOption = await configManager.getMainOption();
    optionsList = await configManager.getOptionsList();
    currentOption = await configManager.getCurrentOption();
    if (currentOption.http_type == undefined) {
        console.log("当前配置文件缺少http_type参数，已自动补全为get");
        currentOption.http_type = "get";
    }
    if (currentOption.headers == undefined) {
        console.log("当前配置文件缺少headers参数，已自动补全为空对象");
        currentOption.headers = {};
    }

    const apiOpenOptions = view.querySelector(".text_to_speech .open");
    const apiReloadOptions = view.querySelector(".text_to_speech .reload");
    const enableTTSPreview = view.querySelector(".text_to_speech .enableTTSPreview");
    const enableTTSCache = view.querySelector(".text_to_speech .enableTTSCache");

    apiOpenOptions.addEventListener("click", async () => {
        await text_to_speech.openFileManager(LiteLoader.plugins["text_to_speech"].path.data);
    });

    apiReloadOptions.addEventListener("click", async () => {
        mainOption = await configManager.getMainOption();
        optionsList = await configManager.getOptionsList();
        currentOption = await configManager.getCurrentOption();
        let optionNameEditing = mainOption.currentOption;
        view.querySelector(".text_to_speech .option-select").innerHTML = optionsList.map((optionName) => {
            return `<option value="${optionName}" ${optionName === optionNameEditing ? "selected" : ""}>${optionName}</option>`;
        }).join("");
        optionsEditing = await text_to_speech.getSubOptions(optionNameEditing);
        enableTTSPreview.toggleAttribute("is-active", mainOption.enableTTSPreview);
        enableTTSCache.toggleAttribute("is-active", mainOption.enableTTSCache);
        // 渲染参数到UI
        if (optionsEditing.http_type == undefined) {
            console.log("当前配置文件缺少http_type参数，已自动补全为get");
            optionsEditing.http_type = "get";
        }
        if (optionsEditing.headers == undefined) {
            console.log("当前配置文件缺少headers参数，已自动补全为空对象");
            optionsEditing.headers = {};
        }
        renderParams(view, optionsEditing);
        renderHeaders(view, optionsEditing);
        api_input.value = optionsEditing.host;
        apiType.value = optionsEditing.host_type;
        httpType.value = optionsEditing.http_type;
    });

    enableTTSPreview.toggleAttribute("is-active", mainOption.enableTTSPreview);
    enableTTSCache.toggleAttribute("is-active", mainOption.enableTTSCache);

    enableTTSPreview.addEventListener("click", async () => {
        const newValue = enableTTSPreview.toggleAttribute("is-active");
        mainOption.enableTTSPreview = newValue;
        await configManager.setMainOption(mainOption);
    });

    enableTTSCache.addEventListener("click", async () => {
        const newValue = enableTTSCache.toggleAttribute("is-active");
        mainOption.enableTTSCache = newValue;
        await configManager.setMainOption(mainOption);
    });

    // 选择当前编辑的配置文件
    const optionSelect = view.querySelector(".text_to_speech .option-select");

    // 获取配置文件中的参数
    let optionNameEditing = mainOption.currentOption;
    optionSelect.innerHTML = optionsList.map((optionName) => {
        return `<option value="${optionName}" ${optionName === optionNameEditing ? "selected" : ""}>${optionName}</option>`;
    }).join("");
    optionSelect.addEventListener("change", async (e) => {
        optionNameEditing = e.target.value;
        currentOption = await configManager.setCurrentOption(optionNameEditing);
        if (currentOption.http_type == undefined) {
            console.log("当前配置文件缺少http_type参数，已自动补全为get");
            currentOption.http_type = "get";
        }
        if (currentOption.headers == undefined) {
            console.log("当前配置文件缺少headers参数，已自动补全为空对象");
            currentOption.headers = {};
        }
        optionsEditing = currentOption;
        renderParams(view, optionsEditing);
        renderHeaders(view, optionsEditing);
        api_input.value = optionsEditing.host;
        apiType.value = optionsEditing.host_type;
        httpType.value = optionsEditing.http_type;
    });

    let optionsEditing = currentOption;
    renderParams(view, optionsEditing);
    renderHeaders(view, optionsEditing);

    // 新建空白子配置/刷新本地子配置列表
    const subconfigCreator = view.querySelector(".text_to_speech .new-subconfig");
    subconfigCreator.addEventListener("click", async () => {
        optionsList = await configManager.refreshOptionsList();
        view.querySelector(".text_to_speech .option-select").innerHTML = optionsList.map((optionName) => {
            return `<option value="${optionName}" ${optionName === optionNameEditing ? "selected" : ""}>${optionName}</option>`;
        }).join("");
    });

    // TODO:获取模板列表，提供下载模板列表的功能。

    // 固定参数：host
    const api_input = view.querySelector(".text_to_speech .api-input");
    const reset = view.querySelector(".text_to_speech .reset");
    const apply = view.querySelector(".text_to_speech .apply");

    // 设置默认值
    api_input.value = optionsEditing.host;
    reset.addEventListener("click", async () => {
        api_input.value = "https://artrajz-vits-simple-api.hf.space/voice/vits";
        optionsEditing.host = api_input.value;
        // 默认存储的文件即为data目录中的config.json
        await text_to_speech.setSubOptions(optionNameEditing, optionsEditing);
        alert("已恢复默认 API");
    });
    apply.addEventListener("click", async () => {
        optionsEditing.host = api_input.value;
        await text_to_speech.setSubOptions(optionNameEditing, optionsEditing);
        alert("已应用新 API");
    });

    // 固定参数：host_type
    const apiType = view.querySelector(".text_to_speech .api-type-input");
    const apiType_apply = view.querySelector(".text_to_speech .api-type-input-apply");
    const apiType_reset = view.querySelector(".text_to_speech .api-type-input-reset");

    // 设置默认值
    apiType.value = optionsEditing.host_type;
    apiType_apply.addEventListener("click", async () => {
        optionsEditing.host_type = apiType.value;
        await text_to_speech.setSubOptions(optionNameEditing, optionsEditing);
        alert("已设置API参数类型");
    });
    apiType_reset.addEventListener("click", async () => {
        apiType.value = "vits";
        optionsEditing.host_type = "vits";
        await text_to_speech.setSubOptions(optionNameEditing, optionsEditing);
        alert("已恢复默认API参数类型");
    });


    // 固定参数：http_type
    const httpType = view.querySelector(".text_to_speech .http-type-select");
    const httpType_apply = view.querySelector(".text_to_speech .http-type-input-apply");
    const httpType_reset = view.querySelector(".text_to_speech .http-type-input-reset");

    // 设置默认值
    console.log("当前子配置参数：", optionsEditing.http_type);
    httpType.value = optionsEditing.http_type;
    // 选择当前子配置中的http_type参数
    const httpTypeSelect = view.querySelector(".text_to_speech .http-type-select");

    httpTypeSelect.innerHTML = [`get`, `post`].map((httpTypeName) => {
        return `<option value="${httpTypeName}" ${httpTypeName === httpType.value ? "selected" : ""}>${httpTypeName}</option>`;
    }).join("");
    httpTypeSelect.addEventListener("change", async (e) => {
        optionsEditing.http_type = e.target.value;
        httpType.value = optionsEditing.http_type;
    });


    httpType_apply.addEventListener("click", async () => {
        optionsEditing.http_type = httpType.value;
        await text_to_speech.setSubOptions(optionNameEditing, optionsEditing);
        alert("已设置API参数类型");
    });
    httpType_reset.addEventListener("click", async () => {
        httpType.value = "get";
        optionsEditing.http_type = "get";
        await text_to_speech.setSubOptions(optionNameEditing, optionsEditing);
        alert("已恢复默认API参数类型");
    });

    // 新增参数按钮事件
    const addParamBtn = view.querySelector(".text_to_speech .add-param");
    addParamBtn.addEventListener("click", () => {
        tmpParamKey = "";
        tmpParamValue = "";
        let tmpParamType = "string"; // 默认类型为字符串
        const addParamContainer = view.querySelector(".text_to_speech .add-param-container");
        addParamContainer.innerHTML = '';
        const addParamElement = document.createElement("setting-item");
        addParamElement.classList.add("param-entry");
        addParamElement.setAttribute("data-direction", "row");
        addParamElement.innerHTML = `
            <div class="input-group" style="flex-direction: column; align-items: stretch;">
                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <input class="add-param-key" type="text" placeholder="请输入参数Key" value="" style="flex: 2;" />
                    <select class="add-param-type" style="flex: 1;">
                        <option value="string">字符串</option>
                        <option value="number">数字</option>
                        <option value="boolean">布尔</option>
                        <option value="object">对象</option>
                    </select>
                </div>
                <div style="display: flex; gap: 8px;">
                    <input class="add-param-value" type="text" placeholder="请输入参数值" value="" style="flex: 1;" />
                    <div class="ops-btns">
                        <setting-button data-type="secondary" class="add-param-confirm">确认</setting-button>
                    </div>
                    <div class="ops-btns">
                        <setting-button data-type="secondary" class="add-param-remove">取消</setting-button>
                    </div>
                </div>
            </div>
        `;
        addParamContainer.appendChild(addParamElement);

        const typeSelect = addParamElement.querySelector(".add-param-type");
        const valueInput = addParamElement.querySelector(".add-param-value");

        // 根据类型切换输入控件
        typeSelect.addEventListener("change", (e) => {
            tmpParamType = e.target.value;
            const container = valueInput.parentElement;
            const newInput = document.createElement(tmpParamType === 'object' ? 'textarea' : 'input');
            newInput.className = 'add-param-value';
            newInput.style.flex = '1';

            switch (tmpParamType) {
                case 'boolean':
                    newInput.innerHTML = '<option value="true">true</option><option value="false">false</option>';
                    const select = document.createElement('select');
                    select.className = 'add-param-value';
                    select.style.flex = '1';
                    select.innerHTML = '<option value="true">true</option><option value="false">false</option>';
                    container.replaceChild(select, valueInput);
                    select.addEventListener("change", (e) => {
                        tmpParamValue = e.target.value === 'true';
                    });
                    tmpParamValue = true;
                    return;
                case 'object':
                    newInput.rows = 3;
                    newInput.style.resize = 'vertical';
                    newInput.style.fontFamily = 'monospace';
                    newInput.placeholder = '请输入JSON对象，如 {"key": "value"}';
                    newInput.value = '{}';
                    tmpParamValue = {};
                    break;
                case 'number':
                    newInput.type = 'number';
                    newInput.step = 'any';
                    newInput.placeholder = '请输入数字';
                    newInput.value = '0';
                    tmpParamValue = 0;
                    break;
                default:
                    newInput.type = 'text';
                    newInput.placeholder = '请输入参数值';
                    newInput.value = '';
                    tmpParamValue = '';
            }
            container.replaceChild(newInput, valueInput);
            newInput.addEventListener("input", (e) => {
                if (tmpParamType === 'object') {
                    try {
                        tmpParamValue = JSON.parse(e.target.value);
                        newInput.style.borderColor = '';
                    } catch (error) {
                        newInput.style.borderColor = 'red';
                    }
                } else if (tmpParamType === 'number') {
                    tmpParamValue = parseFloat(e.target.value) || 0;
                } else {
                    tmpParamValue = e.target.value;
                }
            });
        });

        addParamElement.querySelector(".add-param-confirm").addEventListener("click", () => {
            if (tmpParamKey && !optionsEditing.params[tmpParamKey]) {
                if (tmpParamType === 'object' && typeof tmpParamValue === 'string') {
                    try {
                        tmpParamValue = JSON.parse(tmpParamValue);
                    } catch (error) {
                        alert("JSON 格式错误！");
                        return;
                    }
                }
                optionsEditing.params[tmpParamKey] = tmpParamValue;
                addParamContainer.removeChild(addParamElement);
                renderParams(view, optionsEditing);
            } else {
                alert("参数名已存在或无效！");
            }
        });
        addParamElement.querySelector(".add-param-remove").addEventListener("click", () => {
            addParamContainer.removeChild(addParamElement);
        });
        addParamElement.querySelector(".add-param-key").addEventListener("input", (e) => {
            tmpParamKey = e.target.value;
        });
        addParamElement.querySelector(".add-param-value").addEventListener("input", (e) => {
            if (tmpParamType === 'object') {
                try {
                    tmpParamValue = JSON.parse(e.target.value);
                    e.target.style.borderColor = '';
                } catch (error) {
                    e.target.style.borderColor = 'red';
                }
            } else if (tmpParamType === 'number') {
                tmpParamValue = parseFloat(e.target.value) || 0;
            } else {
                tmpParamValue = e.target.value;
            }
        });
    });

    // 新增请求头按钮事件
    const addHeaderBtn = view.querySelector(".text_to_speech .add-header");
    addHeaderBtn.addEventListener("click", () => {
        tmpHeaderKey = "";
        tmpHeaderValue = "";
        let tmpHeaderType = "string"; // 默认类型为字符串
        const addHeaderContainer = view.querySelector(".text_to_speech .add-header-container");
        addHeaderContainer.innerHTML = '';
        const addHeaderElement = document.createElement("setting-item");
        addHeaderElement.classList.add("header-entry");
        addHeaderElement.setAttribute("data-direction", "row");
        addHeaderElement.innerHTML = `
            <div class="input-group" style="flex-direction: column; align-items: stretch;">
                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <input class="add-header-key" type="text" placeholder="请输入请求头Key，如Authorization" value="" style="flex: 2;" />
                    <select class="add-header-type" style="flex: 1;">
                        <option value="string">字符串</option>
                        <option value="number">数字</option>
                        <option value="boolean">布尔</option>
                        <option value="object">对象</option>
                    </select>
                </div>
                <div style="display: flex; gap: 8px;">
                    <input class="add-header-value" type="text" placeholder="请输入请求头值" value="" style="flex: 1;" />
                    <div class="ops-btns">
                        <setting-button data-type="secondary" class="add-header-confirm">确认</setting-button>
                    </div>
                    <div class="ops-btns">
                        <setting-button data-type="secondary" class="add-header-remove">取消</setting-button>
                    </div>
                </div>
            </div>
        `;
        addHeaderContainer.appendChild(addHeaderElement);

        const typeSelect = addHeaderElement.querySelector(".add-header-type");
        const valueInput = addHeaderElement.querySelector(".add-header-value");

        // 根据类型切换输入控件
        typeSelect.addEventListener("change", (e) => {
            tmpHeaderType = e.target.value;
            const container = valueInput.parentElement;
            const newInput = document.createElement(tmpHeaderType === 'object' ? 'textarea' : 'input');
            newInput.className = 'add-header-value';
            newInput.style.flex = '1';

            switch (tmpHeaderType) {
                case 'boolean':
                    const select = document.createElement('select');
                    select.className = 'add-header-value';
                    select.style.flex = '1';
                    select.innerHTML = '<option value="true">true</option><option value="false">false</option>';
                    container.replaceChild(select, valueInput);
                    select.addEventListener("change", (e) => {
                        tmpHeaderValue = e.target.value === 'true';
                    });
                    tmpHeaderValue = true;
                    return;
                case 'object':
                    newInput.rows = 3;
                    newInput.style.resize = 'vertical';
                    newInput.style.fontFamily = 'monospace';
                    newInput.placeholder = '请输入JSON对象，如 {"key": "value"}';
                    newInput.value = '{}';
                    tmpHeaderValue = {};
                    break;
                case 'number':
                    newInput.type = 'number';
                    newInput.step = 'any';
                    newInput.placeholder = '请输入数字';
                    newInput.value = '0';
                    tmpHeaderValue = 0;
                    break;
                default:
                    newInput.type = 'text';
                    newInput.placeholder = '请输入请求头值';
                    newInput.value = '';
                    tmpHeaderValue = '';
            }
            container.replaceChild(newInput, valueInput);
            newInput.addEventListener("input", (e) => {
                if (tmpHeaderType === 'object') {
                    try {
                        tmpHeaderValue = JSON.parse(e.target.value);
                        newInput.style.borderColor = '';
                    } catch (error) {
                        newInput.style.borderColor = 'red';
                    }
                } else if (tmpHeaderType === 'number') {
                    tmpHeaderValue = parseFloat(e.target.value) || 0;
                } else {
                    tmpHeaderValue = e.target.value;
                }
            });
        });

        addHeaderElement.querySelector(".add-header-confirm").addEventListener("click", () => {
            if (tmpHeaderKey && !optionsEditing.headers[tmpHeaderKey]) {
                if (tmpHeaderType === 'object' && typeof tmpHeaderValue === 'string') {
                    try {
                        tmpHeaderValue = JSON.parse(tmpHeaderValue);
                    } catch (error) {
                        alert("JSON 格式错误！");
                        return;
                    }
                }
                optionsEditing.headers[tmpHeaderKey] = tmpHeaderValue;
                addHeaderContainer.removeChild(addHeaderElement);
                renderHeaders(view, optionsEditing);
            } else {
                alert("请求头名称已存在或无效！");
            }
        });
        addHeaderElement.querySelector(".add-header-remove").addEventListener("click", () => {
            addHeaderContainer.removeChild(addHeaderElement);
        });
        addHeaderElement.querySelector(".add-header-key").addEventListener("input", (e) => {
            tmpHeaderKey = e.target.value;
        });
        addHeaderElement.querySelector(".add-header-value").addEventListener("input", (e) => {
            if (tmpHeaderType === 'object') {
                try {
                    tmpHeaderValue = JSON.parse(e.target.value);
                    e.target.style.borderColor = '';
                } catch (error) {
                    e.target.style.borderColor = 'red';
                }
            } else if (tmpHeaderType === 'number') {
                tmpHeaderValue = parseFloat(e.target.value) || 0;
            } else {
                tmpHeaderValue = e.target.value;
            }
        });
    });

    // 总的子配置保存按钮
    const saveAllBtn = view.querySelector(".text_to_speech .save-all");
    saveAllBtn.addEventListener("click", async () => {
        await text_to_speech.setSubOptions(optionNameEditing, optionsEditing);
        alert("所有参数已保存！");
    });



    // view 为 Element 对象，修改将同步到插件设置界面
}
