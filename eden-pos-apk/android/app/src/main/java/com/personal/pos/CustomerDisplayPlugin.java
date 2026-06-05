package com.personal.pos;

import android.app.Presentation;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.os.Bundle;
import android.util.Base64;
import android.view.Display;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.NumberFormat;
import java.util.Locale;

@CapacitorPlugin(name = "CustomerDisplay")
public class CustomerDisplayPlugin extends Plugin {
    private CustomerPresentation presentation;

    @PluginMethod
    public void getDisplays(PluginCall call) {
        JSObject result = new JSObject();
        JSArray displays = new JSArray();
        Display[] presentationDisplays = presentationDisplays();

        for (Display display : presentationDisplays) {
            JSObject item = new JSObject();
            item.put("id", display.getDisplayId());
            item.put("name", display.getName());
            item.put("width", display.getMode().getPhysicalWidth());
            item.put("height", display.getMode().getPhysicalHeight());
            item.put("rotation", display.getRotation());
            displays.put(item);
        }

        result.put("available", presentationDisplays.length > 0);
        result.put("displays", displays);
        call.resolve(result);
    }

    @PluginMethod
    public void show(PluginCall call) {
        JSObject state = call.getObject("state", new JSObject());
        JSObject settings = call.getObject("settings", new JSObject());
        Display[] displays = presentationDisplays();

        if (displays.length == 0) {
            JSObject result = new JSObject();
            result.put("available", false);
            call.resolve(result);
            return;
        }

        getActivity().runOnUiThread(() -> {
            Display display = displays[0];

            if (presentation == null || presentation.getDisplay().getDisplayId() != display.getDisplayId()) {
                dismissPresentation();
                presentation = new CustomerPresentation(getActivity(), display);
                presentation.show();
            }

            presentation.update(state, settings);
            JSObject result = new JSObject();
            result.put("available", true);
            result.put("displayName", display.getName());
            call.resolve(result);
        });
    }

    @PluginMethod
    public void update(PluginCall call) {
        JSObject state = call.getObject("state", new JSObject());
        JSObject settings = call.getObject("settings", new JSObject());

        getActivity().runOnUiThread(() -> {
            if (presentation != null && presentation.isShowing()) {
                presentation.update(state, settings);
                JSObject result = new JSObject();
                result.put("available", true);
                call.resolve(result);
                return;
            }

            Display[] displays = presentationDisplays();
            if (displays.length == 0) {
                JSObject result = new JSObject();
                result.put("available", false);
                call.resolve(result);
                return;
            }

            presentation = new CustomerPresentation(getActivity(), displays[0]);
            presentation.show();
            presentation.update(state, settings);
            JSObject result = new JSObject();
            result.put("available", true);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void dismiss(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            dismissPresentation();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        dismissPresentation();
        super.handleOnDestroy();
    }

    private Display[] presentationDisplays() {
        DisplayManager displayManager = (DisplayManager) getContext().getSystemService(Context.DISPLAY_SERVICE);
        if (displayManager == null) return new Display[0];
        return displayManager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION);
    }

    private void dismissPresentation() {
        if (presentation == null) return;

        if (presentation.isShowing()) {
            presentation.dismiss();
        }
        presentation = null;
    }

    private static class CustomerPresentation extends Presentation {
        private final NumberFormat currency = NumberFormat.getCurrencyInstance(new Locale("th", "TH"));
        private LinearLayout root;

        CustomerPresentation(Context outerContext, Display display) {
            super(outerContext, display);
        }

        @Override
        protected void onCreate(Bundle savedInstanceState) {
            super.onCreate(savedInstanceState);
            Window window = getWindow();
            if (window != null) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }

            root = new LinearLayout(getContext());
            root.setOrientation(LinearLayout.VERTICAL);
            root.setPadding(dp(22), dp(16), dp(22), dp(16));
            root.setGravity(Gravity.CENTER_HORIZONTAL);
            setContentView(root);
        }

        void update(JSObject state, JSObject settings) {
            if (root == null) return;

            root.removeAllViews();
            GradientDrawable background = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[] { Color.rgb(12, 112, 55), Color.rgb(159, 218, 28) }
            );
            root.setBackgroundColor(Color.rgb(247, 250, 247));

            String storeName = state.optString("storeName", "Eden Cafe");
            String idleMessage = settings.optString("idleMessage", "ยินดีต้อนรับสู่ Eden Cafe");
            String promoMessage = settings.optString("promoMessage", "รายการสินค้าและยอดชำระจะแสดงที่หน้าจอนี้");
            JSONArray lines = state.optJSONArray("lines");
            int lineCount = lines == null ? 0 : lines.length();
            double total = state.optDouble("total", 0);
            String paymentLabel = state.optString("paymentLabel", "");
            boolean showLineItems = settings.optBoolean("showLineItems", true);
            boolean showQr = settings.optBoolean("showQr", true);
            Bitmap qrBitmap = showQr
                ? qrImageFromDataUrl(state.optString("promptPayQrDataUrl", ""))
                : null;

            TextView brand = text(storeName, lineCount > 0 ? 20 : 30, true, Color.rgb(11, 111, 58));
            brand.setGravity(Gravity.CENTER);
            root.addView(brand, matchWrap());

            TextView headline = text(lineCount > 0 ? "ยอดชำระ" : idleMessage, lineCount > 0 ? 16 : 24, true, Color.rgb(82, 96, 89));
            headline.setGravity(Gravity.CENTER);
            headline.setAlpha(0.9f);
            root.addView(headline, matchWrap());

            TextView totalView = text(currency.format(total), lineCount > 0 ? 38 : 48, true, Color.rgb(19, 34, 28));
            totalView.setGravity(Gravity.CENTER);
            totalView.setPadding(0, dp(2), 0, dp(10));
            root.addView(totalView, matchWrap());

            if (lineCount == 0 || !showLineItems) {
                TextView message = text(lineCount == 0 ? promoMessage : "ขอบคุณที่ใช้บริการ", 22, false, Color.rgb(82, 96, 89));
                message.setGravity(Gravity.CENTER);
                message.setAlpha(0.86f);
                root.addView(message, matchWrap());
                return;
            }

            LinearLayout contentRow = new LinearLayout(getContext());
            contentRow.setOrientation(LinearLayout.HORIZONTAL);
            contentRow.setGravity(Gravity.CENTER_VERTICAL);

            LinearLayout listCard = new LinearLayout(getContext());
            listCard.setOrientation(LinearLayout.VERTICAL);
            listCard.setPadding(dp(14), dp(12), dp(14), dp(12));
            GradientDrawable listBg = new GradientDrawable();
            listBg.setColor(Color.WHITE);
            listBg.setCornerRadius(dp(12));
            listBg.setStroke(dp(1), Color.rgb(220, 231, 224));
            listCard.setBackground(listBg);

            LinearLayout listHeader = new LinearLayout(getContext());
            listHeader.setOrientation(LinearLayout.HORIZONTAL);
            listHeader.setGravity(Gravity.CENTER_VERTICAL);
            listHeader.setPadding(0, 0, 0, dp(6));

            TextView itemHeader = text("รายการ", 14, true, Color.rgb(82, 96, 89));
            TextView qtyHeader = text("จำนวน", 14, true, Color.rgb(82, 96, 89));
            TextView priceHeader = text("ราคา", 14, true, Color.rgb(82, 96, 89));
            qtyHeader.setGravity(Gravity.CENTER);
            priceHeader.setGravity(Gravity.RIGHT);
            listHeader.addView(itemHeader, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            listHeader.addView(qtyHeader, new LinearLayout.LayoutParams(dp(62), ViewGroup.LayoutParams.WRAP_CONTENT));
            listHeader.addView(priceHeader, new LinearLayout.LayoutParams(dp(112), ViewGroup.LayoutParams.WRAP_CONTENT));
            listCard.addView(listHeader, matchWrap());

            ScrollView scrollView = new ScrollView(getContext());
            LinearLayout list = new LinearLayout(getContext());
            list.setOrientation(LinearLayout.VERTICAL);
            scrollView.addView(list);

            for (int index = 0; index < lineCount; index += 1) {
                JSONObject line = lines.optJSONObject(index);
                if (line == null) continue;

                LinearLayout row = new LinearLayout(getContext());
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(dp(10), dp(8), dp(10), dp(8));

                GradientDrawable rowBg = new GradientDrawable();
                rowBg.setColor(Color.rgb(246, 250, 247));
                rowBg.setCornerRadius(dp(8));
                row.setBackground(rowBg);

                TextView name = text(line.optString("name", "สินค้า"), 18, true, Color.rgb(19, 34, 28));
                row.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

                TextView quantity = text("x" + line.optInt("quantity", 1), 18, true, Color.rgb(19, 34, 28));
                quantity.setGravity(Gravity.CENTER);
                row.addView(quantity, new LinearLayout.LayoutParams(dp(62), ViewGroup.LayoutParams.WRAP_CONTENT));

                TextView amount = text(currency.format(line.optDouble("total", 0)), 18, true, Color.rgb(19, 34, 28));
                amount.setGravity(Gravity.RIGHT);
                row.addView(amount, new LinearLayout.LayoutParams(dp(112), ViewGroup.LayoutParams.WRAP_CONTENT));

                LinearLayout.LayoutParams rowParams = matchWrap();
                rowParams.setMargins(0, 0, 0, dp(10));
                list.addView(row, rowParams);
            }

            listCard.addView(scrollView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1
            ));

            LinearLayout summaryRow = new LinearLayout(getContext());
            summaryRow.setOrientation(LinearLayout.HORIZONTAL);
            summaryRow.setPadding(0, dp(6), 0, 0);
            TextView summaryLabel = text("ยอดสุทธิ", 18, true, Color.rgb(11, 111, 58));
            TextView summaryAmount = text(currency.format(total), 20, true, Color.rgb(11, 111, 58));
            summaryAmount.setGravity(Gravity.RIGHT);
            summaryRow.addView(summaryLabel, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            summaryRow.addView(summaryAmount, new LinearLayout.LayoutParams(dp(170), ViewGroup.LayoutParams.WRAP_CONTENT));
            listCard.addView(summaryRow, matchWrap());

            contentRow.addView(listCard, new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.MATCH_PARENT,
                1
            ));

            LinearLayout payCard = new LinearLayout(getContext());
            payCard.setOrientation(LinearLayout.VERTICAL);
            payCard.setGravity(Gravity.CENTER_HORIZONTAL);
            payCard.setPadding(dp(16), dp(14), dp(16), dp(14));
            GradientDrawable payBg = new GradientDrawable();
            payBg.setColor(Color.WHITE);
            payBg.setCornerRadius(dp(16));
            payBg.setStroke(dp(1), Color.rgb(184, 220, 196));
            payCard.setBackground(payBg);

            TextView payTitle = text(qrBitmap != null ? "PromptPay QR" : "วิธีชำระเงิน", 18, true, Color.rgb(11, 111, 58));
            payTitle.setGravity(Gravity.CENTER);
            payCard.addView(payTitle, matchWrap());

            TextView payAmount = text(currency.format(total), 30, true, Color.rgb(11, 111, 58));
            payAmount.setGravity(Gravity.CENTER);
            payAmount.setPadding(0, dp(1), 0, dp(8));
            payCard.addView(payAmount, matchWrap());

            if (qrBitmap != null) {
                ImageView qrImage = new ImageView(getContext());
                qrImage.setImageBitmap(qrBitmap);
                qrImage.setAdjustViewBounds(true);
                qrImage.setScaleType(ImageView.ScaleType.FIT_CENTER);
                payCard.addView(qrImage, new LinearLayout.LayoutParams(dp(204), dp(204)));
            } else {
                String methodText = paymentLabel.trim().isEmpty()
                    ? "รอเลือกวิธีชำระเงิน"
                    : paymentLabel + "\nไม่ต้องสแกน QR";
                TextView waiting = text(methodText, 22, true, Color.rgb(11, 111, 58));
                waiting.setGravity(Gravity.CENTER);
                payCard.addView(waiting, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    dp(204)
                ));
            }

            TextView qrHint = text(qrBitmap != null ? "สแกนเพื่อชำระเงิน" : "รอพนักงานยืนยันการชำระเงิน", 16, false, Color.rgb(82, 96, 89));
            qrHint.setGravity(Gravity.CENTER);
            payCard.addView(qrHint, matchWrap());

            LinearLayout.LayoutParams payParams = new LinearLayout.LayoutParams(
                dp(260),
                ViewGroup.LayoutParams.MATCH_PARENT
            );
            payParams.setMargins(dp(16), 0, 0, 0);
            contentRow.addView(payCard, payParams);

            root.addView(contentRow, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1
            ));
        }

        private TextView text(String value, int sp, boolean bold, int color) {
            TextView textView = new TextView(getContext());
            textView.setText(value);
            textView.setTextColor(color);
            textView.setTextSize(sp);
            textView.setIncludeFontPadding(true);
            if (bold) {
                textView.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
            }
            return textView;
        }

        private Bitmap qrImageFromDataUrl(String dataUrl) {
            if (dataUrl == null || dataUrl.trim().isEmpty()) return null;

            try {
                String base64 = dataUrl;
                int commaIndex = dataUrl.indexOf(',');
                if (commaIndex >= 0 && commaIndex < dataUrl.length() - 1) {
                    base64 = dataUrl.substring(commaIndex + 1);
                }
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            } catch (Exception error) {
                return null;
            }
        }

        private LinearLayout.LayoutParams matchWrap() {
            return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            );
        }

        private int dp(int value) {
            return (int) (value * getContext().getResources().getDisplayMetrics().density);
        }
    }
}
